import log from 'loglevel';
import { HttpProvider, TransactionReceipt } from 'web3-core';
import { PrefixedHexString, Transaction } from 'ethereumjs-tx';
import { TypedDataUtils } from 'eth-sig-util';
import { bufferToHex } from 'ethereumjs-util';
import {
    DeployTransactionRequest,
    RelayMetadata,
    RelayTransactionRequest,
    EnvelopingTransactionDetails,
    ContractInteractor,
    EstimateGasParams,
    EnvelopingConfig,
    decodeRevertReason,
    calculateDeployTransactionMaxPossibleGas,
    estimateMaxPossibleRelayCallWithLinearFit,
    constants
} from '@rsksmart/rif-relay-common';
import {
    DeployRequest,
    ForwardRequestType,
    RelayRequest,
    TypedRequestData
} from '@rsksmart/rif-relay-contracts';
import { Address, PingFilter } from './types/Aliases';
import HttpClient from './HttpClient';
import RelaySelectionManager from './RelaySelectionManager';
import { KnownRelaysManager } from './KnownRelaysManager';
import AccountManager from './AccountManager';
import RelayedTransactionValidator from './RelayedTransactionValidator';
import {
    configure,
    getDependencies,
    EnvelopingDependencies
} from './Configurator';
import { RelayInfo } from './types/RelayInfo';
//@ts-ignore
import { EventEmitter } from 'events';
import {
    RelayEvent,
    InitEvent,
    NextRelayEvent,
    DoneRefreshRelaysEvent,
    RefreshRelaysEvent,
    RelayerResponseEvent,
    SendToRelayerEvent,
    SignRequestEvent,
    ValidateRequestEvent
} from './RelayEvents';
import { toBN, toHex } from 'web3-utils';

export const GasPricePingFilter: PingFilter = (
    pingResponse,
    transactionDetails
) => {
    if (
        transactionDetails.gasPrice != null &&
        parseInt(pingResponse.minGasPrice) >
            parseInt(transactionDetails.gasPrice)
    ) {
        throw new Error(
            `Proposed gas price: ${transactionDetails.gasPrice}; relay's MinGasPrice: ${pingResponse.minGasPrice}`
        );
    }
};

export interface RelayingAttempt {
    transaction?: Transaction;
    error?: Error;
}

export interface RelayingResult {
    transaction?: Transaction;
    receipt?: TransactionReceipt;
    pingErrors: Map<string, Error>;
    relayingErrors: Map<string, Error>;
}

export type RelayEstimation = {
    gasPrice: string;
    estimation: string;
    requiredTokenAmount: string;
    requiredNativeAmount: string;
    exchangeRate: string;
};

export class RelayClient {
    readonly emitter = new EventEmitter();
    readonly config: EnvelopingConfig;
    private readonly httpClient: HttpClient;
    protected _contractInteractor: ContractInteractor;
    public get contractInteractor(): ContractInteractor {
        return this._contractInteractor;
    }
    protected knownRelaysManager: KnownRelaysManager;
    private readonly transactionValidator: RelayedTransactionValidator;
    private readonly pingFilter: PingFilter;

    public readonly accountManager: AccountManager;
    private initialized = false;

    /**
     * create a RelayClient library object, to force contracts to go through a relay.
     */
    constructor(
        provider: HttpProvider,
        configOverride: Partial<EnvelopingConfig>,
        overrideDependencies?: Partial<EnvelopingDependencies>
    ) {
        const config = configure(configOverride);
        const dependencies = getDependencies(
            config,
            provider,
            overrideDependencies
        );

        this.config = dependencies.config;
        this.httpClient = dependencies.httpClient;
        this._contractInteractor = dependencies.contractInteractor;
        this.knownRelaysManager = dependencies.knownRelaysManager;
        this.transactionValidator = dependencies.transactionValidator;
        this.accountManager = dependencies.accountManager;
        this.pingFilter = dependencies.pingFilter;
        log.setLevel(this.config.logLevel);
    }

    /**
     * register a listener for Relay events
     * @see RelayEvent and its subclasses for emitted events
     * @param handler callback function to handle events
     */
    registerEventListener(handler: (event: RelayEvent) => void): void {
        this.emitter.on('enveloping', handler);
    }

    /**
     * unregister previously registered event listener
     * @param handler callback function to unregister
     */
    unregisterEventListener(handler: (event: RelayEvent) => void): void {
        this.emitter.off('enveloping', handler);
    }

    private emit(event: RelayEvent): void {
        this.emitter.emit('enveloping', event);
    }

    /**
     * In case Relay Server does not broadcast the signed transaction to the network,
     * client also broadcasts the same transaction. If the transaction fails with nonce
     * error, it indicates Relay may have signed multiple transactions with same nonce,
     * causing a DoS attack.
     *
     * @param {*} transaction - actual Ethereum transaction, signed by a relay
     */
    async _broadcastRawTx(transaction: Transaction): Promise<{
        hasReceipt: boolean;
        broadcastError?: Error;
        wrongNonce?: boolean;
    }> {
        const rawTx = '0x' + transaction.serialize().toString('hex');
        const txHash = '0x' + transaction.hash(true).toString('hex');
        log.info(
            `Broadcasting raw transaction signed by relay. TxHash: ${txHash}`
        );
        try {
            if (await this._isAlreadySubmitted(txHash)) {
                return { hasReceipt: true };
            }

            // can't find the TX in the mempool. broadcast it ourselves.
            await this.contractInteractor.sendSignedTransaction(rawTx);
            return { hasReceipt: true };
        } catch (broadcastError) {
            if (broadcastError instanceof Error) {
                // don't display error for the known-good cases
                if (
                    broadcastError?.message.match(
                        /the tx doesn't have the correct nonce|known transaction/
                    ) != null
                ) {
                    return {
                        hasReceipt: false,
                        wrongNonce: true,
                        broadcastError
                    };
                }
                return { hasReceipt: false, broadcastError };
            } else {
                console.error(broadcastError);
            }
        }
    }

    async _isAlreadySubmitted(txHash: string): Promise<boolean> {
        const [txMinedReceipt, pendingTransaction] = await Promise.all([
            this.contractInteractor.web3.eth.getTransactionReceipt(txHash),
            // considering mempool transactions
            this.contractInteractor.web3.eth.getTransaction(txHash)
        ]);

        if (txMinedReceipt != null || pendingTransaction != null) {
            return true;
        }

        return false;
    }

    async _init(): Promise<void> {
        if (this.initialized) {
            return;
        }
        this.emit(new InitEvent());
        await this.contractInteractor.init();
        this.initialized = true;
    }

    /**
     * Can be used to get an estimate of the maximum possible gas to be used by the transaction by using
     * a linear fit.
     * It has the advantage of not requiring the user to sign the transaction in the relay calls
     * If the transaction details are for a deploy, it won't use a linear fit
     * @param transactionDetails
     * @returns maxPossibleGas: The maximum expected gas to be used by the transaction
     */
    async estimateMaxPossibleRelayGasWithLinearFit(
        transactionDetails: EnvelopingTransactionDetails
    ): Promise<number> {
        const { feesReceiver, relayWorkerAddress } =
            await this.getPingResponse();
        const trxDetails = { ...transactionDetails };
        trxDetails.gasPrice =
            trxDetails.forceGasPrice ?? (await this._calculateGasPrice());
        let maxPossibleGas: number;

        const isSmartWalletDeploy = trxDetails.isSmartWalletDeploy ?? false;

        let tokenGas: number;

        if (trxDetails.tokenGas === undefined || trxDetails.tokenGas == null) {
            tokenGas = await this.estimateTokenTransferGas(trxDetails);
            trxDetails.tokenGas = toHex(tokenGas);
        } else {
            tokenGas = toBN(trxDetails.tokenGas).toNumber();
        }
        if (isSmartWalletDeploy) {
            let deployCallEstimate = 0;

            trxDetails.gas = '0x00';
            const testRequest = await this._prepareFactoryGasEstimationRequest(
                trxDetails,
                feesReceiver
            );
            deployCallEstimate =
                (await this.calculateDeployCallGas(
                    testRequest,
                    relayWorkerAddress
                )) + Number(trxDetails.tokenGas);
            maxPossibleGas = calculateDeployTransactionMaxPossibleGas(
                deployCallEstimate.toString(),
                trxDetails.tokenGas
            ).toNumber();
        } else {
            let destinationGas: number;

            if (trxDetails.gas === undefined || trxDetails.gas == null) {
                destinationGas =
                    await this.contractInteractor.estimateDestinationContractCallGas(
                        trxDetails
                    );
            } else {
                destinationGas = toBN(trxDetails.gas).toNumber();
            }
            maxPossibleGas = estimateMaxPossibleRelayCallWithLinearFit(
                destinationGas,
                tokenGas
            );
        }

        return maxPossibleGas;
    }

    /**
     * Can be used to get an estimate of the maximum possible gas to be used by the transaction
     * @param transactionDetails
     * @returns maxPossibleGas: The maximum expected gas to be used by the transaction
     */
    async estimateMaxPossibleRelayGas(
        transactionDetails: EnvelopingTransactionDetails
    ): Promise<number> {
        const { feesReceiver, relayWorkerAddress } =
            await this.getPingResponse();
        const trxDetails = { ...transactionDetails };
        trxDetails.gasPrice =
            trxDetails.forceGasPrice ?? (await this._calculateGasPrice());
        let maxPossibleGas: BN;

        const isSmartWalletDeploy = trxDetails.isSmartWalletDeploy ?? false;

        trxDetails.tokenGas =
            trxDetails.tokenGas ??
            (await this.estimateTokenTransferGas(trxDetails)).toString();
        let deployCallEstimate = 0;

        if (isSmartWalletDeploy) {
            trxDetails.gas = '0x00';
            const testRequest = await this._prepareFactoryGasEstimationRequest(
                trxDetails,
                feesReceiver
            );
            deployCallEstimate =
                (await this.calculateDeployCallGas(
                    testRequest,
                    relayWorkerAddress
                )) + Number(trxDetails.tokenGas);
            maxPossibleGas = calculateDeployTransactionMaxPossibleGas(
                deployCallEstimate.toString(),
                trxDetails.tokenGas
            );
        } else {
            const estimated =
                (await this.calculateSmartWalletRelayGas(
                    trxDetails,
                    relayWorkerAddress,
                    feesReceiver
                )) + Number(trxDetails.tokenGas);

            //FIXME check why two times its being multiply by ESTIMATED_GAS_CORRECTION_FACTOR
            maxPossibleGas = toBN(
                Math.ceil(estimated * constants.ESTIMATED_GAS_CORRECTION_FACTOR)
            );
        }

        return maxPossibleGas.toNumber();
    }

    // Used to estimate the gas cost of calling relayHub.deployCall (assuming no payment in tokens is done)
    // The reason the tokenPayment is removed is for allowing the user to sign the payload for an estimate, being
    // assured she won't be charged since tokenAmount is 0
    // The tokenGas must be added to this result in order to get the full estimate
    async calculateDeployCallGas(
        deployRequest: DeployTransactionRequest,
        relayWorker: string
    ): Promise<number> {
        const estimatedGas: number =
            await this.contractInteractor.walletFactoryEstimateGasOfDeployCall(
                deployRequest,
                relayWorker
            );
        return estimatedGas;
    }

    // Used to estimate the gas cost of calling relayHub.relayCall (assuming no payment in tokens is done)
    // The reason the tokenPayment is removed is for allowing the user to sign the payload for an estimate, being
    // assured she won't be charged since tokenAmount is 0
    // The tokenGas must be added to this result in order to get the full estimate
    async calculateSmartWalletRelayGas(
        transactionDetails: EnvelopingTransactionDetails,
        relayWorker: string,
        feesReceiver: string
    ): Promise<number> {
        const testInfo = await this._prepareRelayHttpRequest(
            {
                pingResponse: {
                    relayWorkerAddress: relayWorker,
                    relayManagerAddress: constants.ZERO_ADDRESS,
                    relayHubAddress: constants.ZERO_ADDRESS,
                    feesReceiver,
                    minGasPrice: '0',
                    ready: true,
                    version: ''
                },
                relayInfo: {
                    manager: '',
                    url: '',
                    registered: false,
                    currentlyStaked: false
                }
            },
            { ...transactionDetails, tokenAmount: '0' }
        );

        if (
            transactionDetails.relayHub === undefined ||
            transactionDetails.relayHub === null ||
            transactionDetails.relayHub === constants.ZERO_ADDRESS
        ) {
            throw new Error(
                'calculateSmartWalletDeployGasNewWay: RelayHub must be defined'
            );
        }

        const estimatedGas: number =
            await this.contractInteractor.estimateRelayTransactionMaxPossibleGasWithTransactionRequest(
                testInfo,
                relayWorker
            );
        return estimatedGas;
    }

    async _prepareFactoryGasEstimationRequest(
        transactionDetails: EnvelopingTransactionDetails,
        feesReceiver: string
    ): Promise<DeployTransactionRequest> {
        if (
            transactionDetails.isSmartWalletDeploy === undefined ||
            !transactionDetails.isSmartWalletDeploy
        ) {
            throw new Error('Request type is not for SmartWallet deploy');
        }
        const callForwarder = this.resolveForwarder(transactionDetails);
        const senderNonce = await this.contractInteractor.getFactoryNonce(
            callForwarder,
            transactionDetails.from
        );
        const gasPrice = BigInt(
            transactionDetails.gasPrice ?? '0x00'
        ).toString();
        const value = BigInt(transactionDetails.value ?? '0').toString();

        // Token payment is estimated separatedly
        const tokenAmount = '0x0';
        const tokenGas = '0x0';

        const relayRequest: DeployRequest = {
            request: {
                relayHub:
                    transactionDetails.relayHub ?? this.config.relayHubAddress,
                to: transactionDetails.to, // optional LogicAddr
                data: transactionDetails.data, // optional InitParams for LogicAddr
                from: transactionDetails.from, // owner EOA
                value: value,
                nonce: senderNonce,
                tokenAmount: tokenAmount,
                tokenGas: tokenGas,
                tokenContract:
                    transactionDetails.tokenContract ?? constants.ZERO_ADDRESS,
                recoverer:
                    transactionDetails.recoverer ?? constants.ZERO_ADDRESS,
                index: transactionDetails.index ?? '0'
            },
            relayData: {
                gasPrice,
                callVerifier:
                    transactionDetails.callVerifier ?? constants.ZERO_ADDRESS,
                callForwarder: callForwarder,
                feesReceiver
            }
        };

        const signature = await this.accountManager.sign(relayRequest);

        const metadata: RelayMetadata = {
            relayHubAddress: this.config.relayHubAddress,
            signature,
            relayMaxNonce: 0
        };

        const httpRequest: DeployTransactionRequest = {
            relayRequest,
            metadata
        };
        return httpRequest;
    }

    async estimateTokenTransferGas(
        transactionDetails: EnvelopingTransactionDetails
    ): Promise<number> {
        const { feesReceiver } = await this.getPingResponse();
        let gasCost = 0;
        const tokenContract =
            transactionDetails.tokenContract ?? constants.ZERO_ADDRESS;

        if (
            tokenContract !== constants.ZERO_ADDRESS &&
            toBN(transactionDetails.tokenAmount ?? '0').gt(toBN(0))
        ) {
            let tokenOrigin: string;

            if (transactionDetails.isSmartWalletDeploy ?? false) {
                // If it is a deploy and tokenGas was not defined, then the smartwallet address is needed to estimate the token gas
                const smartWalletAddress =
                    transactionDetails.smartWalletAddress ??
                    constants.ZERO_ADDRESS;

                if (smartWalletAddress === constants.ZERO_ADDRESS) {
                    throw Error(
                        'In a deploy, if tokenGas is not defined, then the calculated SmartWallet address is needed to estimate the tokenGas value'
                    );
                }
                tokenOrigin = smartWalletAddress;
            } else {
                tokenOrigin = this.resolveForwarder(transactionDetails); // the smart wallet
            }

            if (tokenOrigin !== constants.ZERO_ADDRESS) {
                const transferParams = [
                    feesReceiver,
                    transactionDetails.tokenAmount ?? '0'
                ];
                log.debug(
                    'estimateTokenTransferGas: transfer parameters [feesReceiver, amount]',
                    transferParams
                );
                const encodedFunction =
                    this.contractInteractor.web3.eth.abi.encodeFunctionCall(
                        {
                            name: 'transfer',
                            type: 'function',
                            inputs: [
                                {
                                    type: 'address',
                                    name: 'recipient'
                                },
                                {
                                    type: 'uint256',
                                    name: 'amount'
                                }
                            ]
                        },
                        transferParams
                    );
                gasCost = await this.contractInteractor.estimateGas({
                    from: tokenOrigin, // token holder is the smart wallet
                    to: tokenContract,
                    gasPrice: transactionDetails.gasPrice,
                    data: encodedFunction
                });
            }
        }

        let internalCallCost =
            gasCost > constants.INTERNAL_TRANSACTION_ESTIMATE_CORRECTION
                ? gasCost - constants.INTERNAL_TRANSACTION_ESTIMATE_CORRECTION
                : gasCost;
        internalCallCost =
            internalCallCost * constants.ESTIMATED_GAS_CORRECTION_FACTOR;

        return internalCallCost;
    }

    getInternalCallCost(transactionDetails: EnvelopingTransactionDetails) {
        return this.contractInteractor.estimateDestinationContractCallGas(
            this.getEstimateGasParams(transactionDetails)
        );
    }

    async relayTransaction(
        transactionDetails: EnvelopingTransactionDetails
    ): Promise<RelayingResult> {
        await this._init();
        log.debug('Relay Client - Relaying transaction');
        log.debug(`Relay Client - Relay Hub:${transactionDetails.relayHub}`);
        // TODO: should have a better strategy to decide how often to refresh known relays
        this.emit(new RefreshRelaysEvent());
        await this.knownRelaysManager.refresh();
        transactionDetails.gasPrice =
            transactionDetails.forceGasPrice ??
            (await this._calculateGasPrice());

        const estimateTokenGas =
            (transactionDetails.tokenGas === undefined ||
                transactionDetails.tokenGas === null) &&
            transactionDetails.tokenAmount !== undefined &&
            transactionDetails.tokenAmount !== null &&
            Number(transactionDetails.tokenAmount) > 0;

        if (transactionDetails.isSmartWalletDeploy ?? false) {
            transactionDetails.gas = '0x00'; // gas field is not required for deploy calls, since there's no need to specify an amount of gas to
            // send to the destination contract as in relay calls. In relay calls it is necessary because if the destination contract reverts, the smart wallet
            // pays for the relay anyway.
        } else if (
            transactionDetails.gas === undefined ||
            transactionDetails.gas == null
        ) {
            const internalCallCost = await this.getInternalCallCost(
                transactionDetails
            );

            transactionDetails.gas = toHex(internalCallCost);
        }
        log.debug(
            `Relay Client - Estimated gas for relaying: ${transactionDetails.gas}`
        );
        const relaySelectionManager = await new RelaySelectionManager(
            transactionDetails,
            this.knownRelaysManager,
            this.httpClient,
            this.pingFilter,
            this.config
        ).init();
        const count = relaySelectionManager.relaysLeft().length;
        this.emit(new DoneRefreshRelaysEvent(count));
        if (count === 0) {
            throw new Error('no registered relayers');
        }
        const relayingErrors = new Map<string, Error>();
        log.debug('Relay Client - Selecting active relay');
        const running = true;
        while (running) {
            let relayingAttempt: RelayingAttempt | undefined;
            const activeRelay = await relaySelectionManager.selectNextRelay();
            if (activeRelay !== undefined && activeRelay !== null) {
                this.emit(new NextRelayEvent(activeRelay.relayInfo.url));

                if (estimateTokenGas) {
                    // Estimate the gas required to transfer the token
                    transactionDetails.tokenGas = (
                        await this.estimateTokenTransferGas(transactionDetails)
                    ).toString();
                }

                relayingAttempt = await this._attemptRelay(
                    activeRelay,
                    transactionDetails
                ).catch((error) => ({ error }));
                if (
                    relayingAttempt.transaction === undefined ||
                    relayingAttempt.transaction === null
                ) {
                    relayingErrors.set(
                        activeRelay.relayInfo.url,
                        relayingAttempt.error ??
                            new Error('No error reason was given')
                    );
                    continue;
                }
                log.debug('Relay Client - Relayed done');
            }
            return {
                transaction: relayingAttempt?.transaction,
                relayingErrors,
                pingErrors: relaySelectionManager.errors
            };
        }
    }

    async _calculateGasPrice(): Promise<PrefixedHexString> {
        const pct = this.config.gasPriceFactorPercent;
        const networkGasPrice = await this.contractInteractor.getGasPrice();
        let gasPrice = Math.round(
            (parseInt(networkGasPrice) * (pct + 100)) / 100
        );
        if (
            this.config.minGasPrice != null &&
            gasPrice < this.config.minGasPrice
        ) {
            gasPrice = this.config.minGasPrice;
        }
        return `0x${gasPrice.toString(16)}`;
    }

    async _attemptRelay(
        relayInfo: RelayInfo,
        transactionDetails: EnvelopingTransactionDetails
    ): Promise<RelayingAttempt> {
        log.info(
            `attempting relay: ${JSON.stringify(
                relayInfo
            )} transaction: ${JSON.stringify(transactionDetails)}`
        );
        const { relayWorkerAddress } = relayInfo.pingResponse;
        let httpRequest: RelayTransactionRequest | DeployTransactionRequest;
        let acceptCallResult;

        if (transactionDetails.isSmartWalletDeploy ?? false) {
            const deployRequest = await this._prepareDeployHttpRequest(
                relayInfo,
                transactionDetails
            );
            this.emit(new ValidateRequestEvent());
            acceptCallResult =
                await this.contractInteractor.validateAcceptDeployCall(
                    deployRequest,
                    relayWorkerAddress
                );
            httpRequest = deployRequest;
        } else {
            httpRequest = await this._prepareRelayHttpRequest(
                relayInfo,
                transactionDetails
            );
            this.emit(new ValidateRequestEvent());
            const {
                relayRequest,
                metadata: { signature }
            } = httpRequest;

            acceptCallResult =
                await this.contractInteractor.validateAcceptRelayCall(
                    relayRequest,
                    signature,
                    relayWorkerAddress
                );

            if (acceptCallResult.revertedInDestination) {
                const message =
                    'Destination contract method reverted in local view call ';
                return {
                    error: new Error(
                        `${message}: ${decodeRevertReason(
                            acceptCallResult.returnValue ?? ''
                        )}`
                    )
                };
            }
        }

        // We don't need to check the user balance with a call to 'erc20.balanceOf'
        // because the same check is performed when RelayVerifier is called

        if (acceptCallResult.reverted) {
            const message = 'local view call reverted';
            return {
                error: new Error(
                    `${message}: ${decodeRevertReason(
                        acceptCallResult.returnValue
                    )}`
                )
            };
        }

        if (!acceptCallResult.verifierAccepted) {
            const message = 'verifier rejected in local view call ';
            return {
                error: new Error(
                    `${message}: ${decodeRevertReason(
                        acceptCallResult.returnValue ?? ''
                    )}`
                )
            };
        }

        let hexTransaction: PrefixedHexString;
        this.emit(new SendToRelayerEvent(relayInfo.relayInfo.url));
        try {
            hexTransaction = await this.httpClient.relayTransaction(
                relayInfo.relayInfo.url,
                httpRequest
            );
        } catch (error) {
            if (error instanceof Error) {
                if (
                    error?.message == null ||
                    error.message.indexOf('timeout') !== -1
                ) {
                    this.knownRelaysManager.saveRelayFailure(
                        new Date().getTime(),
                        relayInfo.relayInfo.manager,
                        relayInfo.relayInfo.url
                    );
                }
                log.info('relayTransaction: ', JSON.stringify(httpRequest));
                return { error };
            } else {
                console.error(error);
            }
        }
        const transaction = new Transaction(
            hexTransaction,
            this.contractInteractor.getRawTxOptions()
        );
        if (
            !this.transactionValidator.validateRelayResponse(
                httpRequest,
                hexTransaction,
                relayWorkerAddress
            )
        ) {
            this.emit(new RelayerResponseEvent(false));
            this.knownRelaysManager.saveRelayFailure(
                new Date().getTime(),
                relayInfo.relayInfo.manager,
                relayInfo.relayInfo.url
            );
            return {
                error: new Error('Returned transaction did not pass validation')
            };
        }
        this.emit(new RelayerResponseEvent(true));
        await this._broadcastRawTx(transaction);
        return {
            transaction
        };
    }

    async _prepareDeployHttpRequest(
        relayInfo: RelayInfo,
        transactionDetails: EnvelopingTransactionDetails
    ): Promise<DeployTransactionRequest> {
        const forwarderAddress = this.resolveForwarder(transactionDetails);
        const senderNonce: string =
            await this.contractInteractor.getFactoryNonce(
                forwarderAddress,
                transactionDetails.from
            );
        const callVerifier =
            transactionDetails.callVerifier ??
            this.config.deployVerifierAddress;
        const { relayWorkerAddress, feesReceiver } = relayInfo.pingResponse;
        const gasPriceHex = transactionDetails.gasPrice;
        if (gasPriceHex == null) {
            throw new Error(
                'RelayClient internal exception. Gas price not calculated. Cannot happen.'
            );
        }
        if (gasPriceHex.indexOf('0x') !== 0) {
            throw new Error(`Invalid gasPrice hex string: ${gasPriceHex}`);
        }

        const gasPrice = parseInt(gasPriceHex, 16).toString();
        const value = transactionDetails.value ?? '0';

        const relayRequest: DeployRequest = {
            request: {
                relayHub: transactionDetails.relayHub ?? constants.ZERO_ADDRESS,
                to: transactionDetails.to,
                data: transactionDetails.data,
                from: transactionDetails.from,
                value: value,
                nonce: senderNonce,
                tokenAmount: transactionDetails.tokenAmount ?? '0x00',
                tokenGas: transactionDetails.tokenGas ?? '0x00',
                tokenContract:
                    transactionDetails.tokenContract ?? constants.ZERO_ADDRESS,
                recoverer:
                    transactionDetails.recoverer ?? constants.ZERO_ADDRESS,
                index: transactionDetails.index ?? '0'
            },
            relayData: {
                gasPrice,
                callVerifier,
                callForwarder: forwarderAddress,
                feesReceiver
            }
        };
        this.emit(new SignRequestEvent());
        const signature = await this.accountManager.sign(relayRequest);
        // max nonce is not signed, as contracts cannot access addresses' nonces.
        const transactionCount =
            await this.contractInteractor.getTransactionCount(
                relayWorkerAddress
            );
        const relayMaxNonce = transactionCount + this.config.maxRelayNonceGap;
        // TODO: the server accepts a flat object, and that is why this code looks like shit.
        //  Must teach server to accept correct types
        const metadata: RelayMetadata = {
            relayHubAddress: this.config.relayHubAddress,
            signature,
            relayMaxNonce
        };
        const httpRequest: DeployTransactionRequest = {
            relayRequest,
            metadata
        };
        log.info(`Created HTTP deploy request: ${JSON.stringify(httpRequest)}`);

        return httpRequest;
    }

    async _prepareRelayHttpRequest(
        relayInfo: RelayInfo,
        transactionDetails: EnvelopingTransactionDetails
    ): Promise<RelayTransactionRequest> {
        const forwarderAddress = this.resolveForwarder(transactionDetails);

        const senderNonce: string =
            await this.contractInteractor.getSenderNonce(forwarderAddress);

        const callVerifier =
            transactionDetails.callVerifier ?? this.config.relayVerifierAddress;
        const relayWorker = relayInfo.pingResponse.relayWorkerAddress;
        const gasPriceHex = transactionDetails.gasPrice;
        const gasLimitHex = transactionDetails.gas;
        if (gasPriceHex == null || gasLimitHex == null) {
            throw new Error(
                'RelayClient internal exception. Gas price or gas limit still not calculated. Cannot happen.'
            );
        }
        if (gasPriceHex.indexOf('0x') !== 0) {
            throw new Error(`Invalid gasPrice hex string: ${gasPriceHex}`);
        }
        if (gasLimitHex.indexOf('0x') !== 0) {
            throw new Error(`Invalid gasLimit hex string: ${gasLimitHex}`);
        }
        const gasLimit = parseInt(gasLimitHex, 16).toString();
        const gasPrice = parseInt(gasPriceHex, 16).toString();
        const value = transactionDetails.value ?? '0';

        const { feesReceiver } = relayInfo.pingResponse;
        const relayRequest: RelayRequest = {
            request: {
                relayHub: transactionDetails.relayHub ?? constants.ZERO_ADDRESS,
                to: transactionDetails.to,
                data: transactionDetails.data,
                from: transactionDetails.from,
                value: value,
                nonce: senderNonce,
                gas: gasLimit,
                tokenAmount: transactionDetails.tokenAmount ?? '0x00',
                tokenGas: transactionDetails.tokenGas ?? '0x00',
                tokenContract:
                    transactionDetails.tokenContract ?? constants.ZERO_ADDRESS
            },
            relayData: {
                gasPrice,
                callVerifier,
                callForwarder: forwarderAddress,
                feesReceiver
            }
        };
        this.emit(new SignRequestEvent());
        const signature = await this.accountManager.sign(relayRequest);
        // max nonce is not signed, as contracts cannot access addresses' nonces.
        const transactionCount =
            await this.contractInteractor.getTransactionCount(relayWorker);
        const relayMaxNonce = transactionCount + this.config.maxRelayNonceGap;
        // TODO: the server accepts a flat object, and that is why this code looks like shit.
        //  Must teach server to accept correct types
        const metadata: RelayMetadata = {
            relayHubAddress: this.config.relayHubAddress,
            signature,
            relayMaxNonce
        };
        const httpRequest: RelayTransactionRequest = {
            relayRequest,
            metadata
        };
        log.info(`Created HTTP relay request: ${JSON.stringify(httpRequest)}`);

        return httpRequest;
    }

    resolveForwarder(
        transactionDetails: EnvelopingTransactionDetails
    ): Address {
        const forwarderAddress =
            transactionDetails.callForwarder ?? constants.ZERO_ADDRESS;
        if (isZeroAddress(forwarderAddress)) {
            throw new Error('No callForwarder address configured');
        }
        return forwarderAddress;
    }

    getEstimateGasParams(
        transactionDetails: EnvelopingTransactionDetails
    ): EstimateGasParams {
        return {
            from: this.resolveForwarder(transactionDetails),
            to: transactionDetails.to,
            gasPrice: transactionDetails.gasPrice,
            data: transactionDetails.data
        };
    }

    async getTransactionReceipt(
        transactionHash: PrefixedHexString,
        retries: number = constants.WAIT_FOR_RECEIPT_RETRIES,
        initialBackoff: number = constants.WAIT_FOR_RECEIPT_INITIAL_BACKOFF
    ): Promise<TransactionReceipt> {
        return await this.contractInteractor.getTransactionReceipt(
            transactionHash,
            retries,
            initialBackoff
        );
    }

    async validateSmartWallet(
        transactionDetails: EnvelopingTransactionDetails
    ): Promise<void> {
        const forwarderAddress = this.resolveForwarder(transactionDetails);
        const senderNonce: string =
            await this.contractInteractor.getSenderNonce(forwarderAddress);

        const relayRequest: RelayRequest = {
            request: {
                relayHub: constants.ZERO_ADDRESS,
                to: transactionDetails.to,
                data: transactionDetails.data,
                from: transactionDetails.from,
                value: '0',
                nonce: senderNonce,
                gas: '0',
                tokenAmount: '0x00',
                tokenGas: '0x00',
                tokenContract: constants.ZERO_ADDRESS
            },
            relayData: {
                gasPrice: '0',
                callVerifier: constants.ZERO_ADDRESS,
                callForwarder: forwarderAddress,
                feesReceiver: constants.ZERO_ADDRESS
            }
        };
        this.emit(new SignRequestEvent());
        const signature = await this.accountManager.sign(relayRequest);
        const suffix = this.suffixData(
            relayRequest,
            this.accountManager.chainId
        );
        await this.contractInteractor.verifyForwarder(
            suffix,
            relayRequest,
            signature
        );
    }

    async estimateGasLimit(
        transactionDetails: EnvelopingTransactionDetails,
        sign: boolean
    ): Promise<RelayEstimation> {
        const relayUrl = this.config.preferredRelays[0];

        const request = await this.prepareRelayRequestGasEstimator(
            transactionDetails,
            sign
        );

        const estimation = await this.httpClient.estimateGasLimit(
            relayUrl,
            request
        );

        return estimation;
    }

    private async prepareRelayRequestGasEstimator(
        transactionDetails: EnvelopingTransactionDetails,
        sign: boolean
    ): Promise<RelayTransactionRequest | DeployTransactionRequest> {
        const callForwarder = this.resolveForwarder(transactionDetails);
        const { feesReceiver } = await this.getPingResponse();
        const gasPrice: number = transactionDetails.forceGasPrice
            ? Number(transactionDetails.forceGasPrice)
            : Number(await this._calculateGasPrice());

        let relayRequest;
        if (transactionDetails.isSmartWalletDeploy) {
            relayRequest = await this.buildEstimationDeployRequest(
                transactionDetails,
                callForwarder,
                feesReceiver,
                gasPrice
            );
        } else {
            relayRequest = await this.buildEstimationRelayRequest(
                transactionDetails,
                callForwarder,
                feesReceiver,
                gasPrice
            );
        }

        let signature = '';
        if (sign) {
            this.emit(new SignRequestEvent());
            signature = await this.accountManager.sign(relayRequest);
        }

        const metadata: RelayMetadata = {
            relayHubAddress: this.config.relayHubAddress,
            signature,
            relayMaxNonce: 0
        };

        return {
            relayRequest,
            metadata
        } as RelayTransactionRequest | DeployTransactionRequest;
    }

    private async buildEstimationDeployRequest(
        transactionDetails: EnvelopingTransactionDetails,
        callForwarder: string,
        feesReceiver: string,
        gasPrice: number
    ): Promise<DeployRequest> {
        const nonce: string = await this.contractInteractor.getFactoryNonce(
            callForwarder,
            transactionDetails.from
        );

        const deployRequest: DeployRequest = {
            request: {
                from: transactionDetails.from,
                to: transactionDetails.to,
                data: transactionDetails.data,
                index: transactionDetails.index ?? '0',
                recoverer:
                    transactionDetails.recoverer ?? constants.ZERO_ADDRESS,
                relayHub:
                    transactionDetails.relayHub ?? this.config.relayHubAddress,
                nonce,
                value: transactionDetails.value ?? '0',
                tokenAmount: '0x0',
                tokenGas: transactionDetails.tokenGas ?? '0x0',
                tokenContract:
                    transactionDetails.tokenContract ?? constants.ZERO_ADDRESS
            },
            relayData: {
                callForwarder: callForwarder,
                callVerifier:
                    transactionDetails.callVerifier ?? constants.ZERO_ADDRESS,
                feesReceiver: feesReceiver,
                gasPrice: transactionDetails.gasPrice ?? gasPrice.toString()
            }
        };

        return deployRequest;
    }

    private async buildEstimationRelayRequest(
        transactionDetails: EnvelopingTransactionDetails,
        callForwarder: string,
        feesReceiver: string,
        gasPrice: number
    ): Promise<RelayRequest> {
        const nonce = await this.contractInteractor.getSenderNonce(
            callForwarder
        );

        const gas: number = transactionDetails.forceGas
            ? Number(transactionDetails.forceGas)
            : await this.getInternalCallCost(transactionDetails);

        const relayRequest: RelayRequest = {
            request: {
                relayHub: transactionDetails.relayHub ?? constants.ZERO_ADDRESS,
                to: transactionDetails.to,
                data: transactionDetails.data,
                from: transactionDetails.from,
                value: transactionDetails.value ?? '0',
                nonce,
                gas: gas.toString(),
                tokenAmount: '0x0',
                tokenGas: transactionDetails.tokenGas ?? '0x0',
                tokenContract:
                    transactionDetails.tokenContract ?? constants.ZERO_ADDRESS
            },
            relayData: {
                callForwarder,
                callVerifier:
                    transactionDetails.callVerifier ?? constants.ZERO_ADDRESS,
                feesReceiver,
                gasPrice: transactionDetails.gasPrice ?? gasPrice.toString()
            }
        };

        return relayRequest;
    }

    private suffixData(relayRequest: RelayRequest, chainId: number) {
        const cloneRequest = { ...relayRequest };
        const signedData = new TypedRequestData(
            chainId,
            relayRequest.relayData.callForwarder,
            cloneRequest as RelayRequest
        );

        const suffixData = bufferToHex(
            TypedDataUtils.encodeData(
                signedData.primaryType,
                signedData.message,
                signedData.types
            ).slice((1 + ForwardRequestType.length) * 32)
        );

        return suffixData;
    }

    private async getPingResponse() {
        return this.httpClient.getPingResponse(this.config.preferredRelays[0]);
    }
}

export function _dumpRelayingResult(relayingResult: RelayingResult): string {
    let str = '';
    if (relayingResult.pingErrors.size > 0) {
        str += `Ping errors (${relayingResult.pingErrors.size}):`;
        Array.from(relayingResult.pingErrors.keys()).forEach((e) => {
            const err = relayingResult.pingErrors.get(e);
            const error = err?.message ?? err?.toString() ?? '';
            str += `\n${e} => ${error}\n`;
        });
    }
    if (relayingResult.relayingErrors.size > 0) {
        str += `Relaying errors (${relayingResult.relayingErrors.size}):\n`;
        Array.from(relayingResult.relayingErrors.keys()).forEach((e) => {
            const err = relayingResult.relayingErrors.get(e);
            const error = err?.message ?? err?.toString() ?? '';
            str += `${e} => ${error}`;
        });
    }
    return str;
}

function isZeroAddress(addr: string) {
    return addr === constants.ZERO_ADDRESS;
}
