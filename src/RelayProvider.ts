import type { Transaction } from 'ethers';
import type { Networkish } from "@ethersproject/networks";
import { JsonRpcProvider, TransactionReceipt } from "@ethersproject/providers";
import type { ConnectionInfo } from "@ethersproject/web";
import { getEnvelopingConfig } from './utils';
import RelayClient, { RequestConfig } from './RelayClient';
import log from 'loglevel';
import { RelayHub__factory } from '@rsksmart/rif-relay-contracts';
import AccountManager from './AccountManager';
import type { UserDefinedEnvelopingRequest } from './common/relayRequest.types';
import { useEnveloping } from './utils';
import BigNumber from 'bignumber.js';
import type { RelayHubInterface } from '@rsksmart/rif-relay-contracts/dist/typechain-types/contracts/RelayHub';

export interface RelayingResult {
    validUntilTime?: string;
    transaction: Transaction;
    receipt?: TransactionReceipt;
}

export default class RelayProvider extends JsonRpcProvider {

    private readonly relayClient!: RelayClient;

    private readonly jsonRpcProvider!: JsonRpcProvider;

    constructor(
        relayClient = new RelayClient(),
        jsonRpcProvider?: JsonRpcProvider,
        providerParams?: { 
            url: ConnectionInfo | string, 
            network: Networkish,
        } 
        ){
            if(jsonRpcProvider){
                super(jsonRpcProvider.connection, jsonRpcProvider._network);
                this.jsonRpcProvider = jsonRpcProvider;
            } else {
                if(!providerParams){
                    throw new Error('Unable to build provider');
                }

                const { url, network } = providerParams;

                super(url, network);
                new JsonRpcProvider(url, network);

            }
            this.relayClient = relayClient;
    }

    private _getRelayStatus(respResult: TransactionReceipt): {
        relayRevertedOnRecipient: boolean;
        transactionRelayed: boolean;
        reason?: string;
    } {
        if (!respResult.logs || respResult.logs.length === 0) {
            return {
                relayRevertedOnRecipient: false,
                transactionRelayed: false,
                reason: 'Tx logs not found'
            };
        }

        const relayHubInterface: RelayHubInterface = RelayHub__factory.createInterface();
        const parsedLogs = respResult.logs.map(log => relayHubInterface.parseLog(log));

        const recipientRejectedEvents = parsedLogs.find(log => log.name == 'TransactionRelayedButRevertedByRecipient');

        if (recipientRejectedEvents) {
            const { reason } = recipientRejectedEvents.args;
            const revertReason = (reason as string);

            return {
                relayRevertedOnRecipient: true,
                transactionRelayed: false,
                reason: revertReason
            };
        }

        const transactionRelayed = parsedLogs.find(log => log.name == 'TransactionRelayed');

        if (transactionRelayed) {
            return {
                relayRevertedOnRecipient: false,
                transactionRelayed: true
            };
        }

        log.info(
            'Neither TransactionRelayed, nor TransactionRelayedButRevertedByRecipient events found. This might be a non-enveloping transaction.'
        );

        return {
            relayRevertedOnRecipient: false,
            transactionRelayed: false,
            reason: 'Neither TransactionRelayed, Deployed, nor TransactionRelayedButRevertedByRecipient events found. This might be a non-enveloping transaction.'
        };
    }

    private async executeRelayTransaction(
        envelopingRequest: UserDefinedEnvelopingRequest,
        requestConfig: RequestConfig
    ): Promise<RelayingResult> {
        try {

            const transaction = await this.relayClient.relayTransaction(
                envelopingRequest, requestConfig
            );

            const { hash } = transaction;

            if(!hash){
                throw new Error('Transaction has no hash!');
            }

            let receipt;
            if(!requestConfig.ignoreTransactionReceipt){
                receipt = await this.waitForTransaction(hash, 1);
            }

            return {
                transaction,
                receipt,
            };
        } catch (error) {
            log.error('Rejected relayTransaction call', error);
            throw new Error(
                `Rejected relayTransaction call - Reason: ${(error as Error).message}`
            );
        }
    }

    private async _ethSendTransaction(
        envelopingRequest: UserDefinedEnvelopingRequest,
        requestConfig: RequestConfig
    ): Promise<RelayingResult> {
        const config = getEnvelopingConfig();

        const { relayData, request } = envelopingRequest;

        let callForwarderValue = await relayData.callForwarder;
        let relayHubValue = await request.relayHub;
        let onlyPreferredRelaysValue = requestConfig.onlyPreferredRelays;
        let gasToSend = requestConfig.forceGasLimit;

        if (!Number(callForwarderValue)) {
            callForwarderValue = config.forwarderAddress;
        }

        if (!Number(relayHubValue)) {
            relayHubValue = config.relayHubAddress;
        }

        if (!onlyPreferredRelaysValue) {
            onlyPreferredRelaysValue = config.onlyPreferredRelays;
        }

        if (gasToSend) {
            gasToSend = BigNumber(gasToSend).toString();
        }

        /**
         * When using a RelayProvider, and the gas field is not manually set, then the original provider within calculates a ridiculously high gas.
         * In order to avoid this, we created a new field called forceGas, which is optional.
         * If the user wants to manually set the gas, then she can put a value in the forceGas field, otherwise it will be
         * automatically estimated (correctly) by the RelayClient.
         * The reason why we added this new forceGas field is because at this point, by reading the gas field,
         * we cannot differentiate between a user-entered gas value from the auto-calculated (and a very poor calculation)
         * value that comes from the original provider
         */

        const userDefinedEnvelopingReq: UserDefinedEnvelopingRequest = {
            relayData: {
                ...envelopingRequest.relayData,
                callForwarder: callForwarderValue,
            }, 
            request: {
                ...envelopingRequest.request,
                relayHub: relayHubValue,
                gas: gasToSend,
            }
        }

        const fullRequestConfig: RequestConfig = {
            ...requestConfig,
            onlyPreferredRelays: onlyPreferredRelaysValue
        }

        const relayingResult = await this.executeRelayTransaction(userDefinedEnvelopingReq, fullRequestConfig);

        if(relayingResult.receipt){
            const { relayRevertedOnRecipient, reason } = this._getRelayStatus(relayingResult.receipt);
            const { transactionHash } = relayingResult.receipt;

            if (relayRevertedOnRecipient) {
                throw new Error(
                        `Transaction Relayed but reverted on recipient - TxHash: ${transactionHash} , Reason: ${reason as string}`
                );
            }
        }

        return relayingResult;
    }

    override async listAccounts() {
        let accountsList = await this.jsonRpcProvider.listAccounts();

        if (accountsList && Array.isArray(accountsList)) {
            const { chainId } = await this.getNetwork();
            const accountManager = new AccountManager(this, chainId);

            const ephemeralAccounts =
                accountManager.getAccounts();

            accountsList = accountsList.concat(ephemeralAccounts);
        }

        return accountsList;
    }

    override send(method: string, params: Array<Record<string, unknown>>): Promise<unknown> {
        if (useEnveloping(method, params)) {
            const { requestConfig, envelopingTx } = params[0] as { requestConfig: RequestConfig, envelopingTx: UserDefinedEnvelopingRequest }
            const { request } = envelopingTx;
            if (method === 'eth_sendTransaction') {

                if (!request.to) {
                    throw new Error(
                        'Relay Provider cannot relay contract deployment transactions. Add {from: accountWithRBTC, useEnveloping: false}.'
                    );
                }

                return this._ethSendTransaction(envelopingTx, requestConfig);
            }

            if (method === 'eth_accounts') {
                return this.listAccounts();
            }

            throw new Error(`Rif Relay unsupported method: ${ method }`);
        }

        return this.jsonRpcProvider.send(method, params);
    }
}