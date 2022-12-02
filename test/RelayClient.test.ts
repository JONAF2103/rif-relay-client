import type { Network } from '@ethersproject/networks';
import {
  EnvelopingTypes,
  IForwarder,
  IForwarder__factory,
} from '@rsksmart/rif-relay-contracts';
import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import config from 'config';
import {
  BigNumber,
  BigNumberish,
  constants,
  providers,
  Signer,
  Wallet,
} from 'ethers';
import Sinon, { SinonStubbedInstance } from 'sinon';
import sinonChai from 'sinon-chai';
import type { EnvelopingConfig } from 'src/common/config.types';
import AccountManager from '../src/AccountManager';
import type { HubInfo } from '../src/common/relayHub.types';
import type {
  RelayRequest,
  RelayRequestBody,
  UserDefinedRelayData,
} from '../src/common/relayRequest.types';
import type { EnvelopingTxRequest } from '../src/common/relayTransaction.types';
import { ENVELOPING_ROOT } from '../src/constants/configs';
import EnvelopingEventEmitter, {
  envelopingEvents,
} from '../src/events/EnvelopingEventEmitter';
import RelayClient from '../src/RelayClient';

use(sinonChai);
use(chaiAsPromised);
const sandbox = Sinon.createSandbox();

const FAKE_ENVELOPING_CONFIG: EnvelopingConfig = {
  // FIXME: move to test utils/constants
  chainId: 3,
  clientId: 3,
  deployVerifierAddress: Wallet.createRandom().address,
  forwarderAddress: Wallet.createRandom().address,
  gasPriceFactorPercent: 3,
  jsonStringifyRequest: false,
  logLevel: 3,
  maxRelayNonceGap: 3,
  methodSuffix: '',
  minGasPrice: 3,
  onlyPreferredRelays: false,
  preferredRelays: [
    {
      currentlyStaked: false,
      manager: Wallet.createRandom().address,
      registered: false,
      url: '',
    },
  ],
  relayHubAddress: Wallet.createRandom().address,
  relayLookupWindowBlocks: 3,
  relayLookupWindowParts: 3,
  relayTimeoutGrace: 3,
  relayVerifierAddress: Wallet.createRandom().address,
  sliceSize: 3,
  smartWalletFactoryAddress: Wallet.createRandom().address,
};

const FAKE_RELAY_REQUEST: RelayRequest = {
  // FIXME: move to test utils/constants
  relayData: {
    callForwarder: Wallet.createRandom().address,
    callVerifier: Wallet.createRandom().address,
    feesReceiver: Wallet.createRandom().address,
    gasPrice: constants.Two,
  },
  request: {
    data: '',
    gas: constants.Two,
    tokenGas: constants.Two,
    nonce: constants.Two,
    relayHub: Wallet.createRandom().address,
    from: Wallet.createRandom().address,
    to: Wallet.createRandom().address,
    tokenAmount: constants.Two,
    tokenContract: Wallet.createRandom().address,
    value: constants.Two,
  },
};

const FAKE_TX_COUNT = 456;
const FAKE_CHAIN_ID = 33;
const FAKE_SIGNATURE = 'FAKE_SIGNATURE';

describe('RelayClient', function () {
  afterEach(function () {
    sandbox.restore();
  });

  describe('_prepareRelayHttpRequest', function () {
    let relayClient: RelayClientExposed;
    let forwarderStub: Sinon.SinonStubbedInstance<IForwarder>;
    let connectForwarderFactoryStub: Sinon.SinonStub<
      [address: string, signerOrProvider: providers.Provider | Signer],
      IForwarder
    >;
    let accountManagerStub: SinonStubbedInstance<AccountManager>;

    type RelayClientExposed = {
      _provider: providers.Provider;
      _prepareRelayHttpRequest: (
        hubInfo: Required<Pick<HubInfo, 'feesReceiver'>>,
        request: EnvelopingTypes.RelayRequestStruct
      ) => Promise<EnvelopingTxRequest>;
    };

    beforeEach(function () {
      relayClient = new RelayClient() as unknown as RelayClientExposed;
      relayClient._provider = {
        _isProvider: true,
        getTransactionCount: sandbox.stub().resolves(FAKE_TX_COUNT),
        getNetwork: sandbox.stub().resolves({
          chainId: FAKE_CHAIN_ID,
        } as Network),
      } as unknown as providers.Provider;

      forwarderStub = {
        nonce: sandbox.stub(),
      } as typeof forwarderStub;

      connectForwarderFactoryStub = sandbox
        .stub(IForwarder__factory, 'connect')
        .returns(forwarderStub);

      accountManagerStub = {
        sign: sandbox
          .stub(AccountManager.prototype, 'sign')
          .resolves(FAKE_SIGNATURE),
      } as typeof accountManagerStub;

      const configStub = sandbox.stub(config);
      configStub.get.withArgs(ENVELOPING_ROOT).returns({
        ...FAKE_ENVELOPING_CONFIG,
        forwarderAddress: Wallet.createRandom().address,
      });
    });

    it('should connect to forwarder', async function () {
      forwarderStub.nonce.resolves(BigNumber.from(123));
      await relayClient._prepareRelayHttpRequest(
        {
          feesReceiver: constants.AddressZero,
        },
        FAKE_RELAY_REQUEST
      );

      expect(connectForwarderFactoryStub).to.have.been.called;
      expect(connectForwarderFactoryStub).to.have.been.calledWith();
    });

    it('should return request with updated nonce from forwarder', async function () {
      const expectedNonce = BigNumber.from((Math.random() * 100).toFixed(0));
      forwarderStub.nonce.resolves(expectedNonce);
      const {
        relayRequest: {
          request: { nonce: actualNonce },
        },
      } = await relayClient._prepareRelayHttpRequest(
        {
          feesReceiver: constants.AddressZero,
        },
        FAKE_RELAY_REQUEST
      );

      expect(actualNonce).to.equal(expectedNonce);
    });

    it('should return tx request with given relay request body except for nonce', async function () {
      const expectedRelayRequestBody: RelayRequestBody = {
        ...FAKE_RELAY_REQUEST.request,
        nonce: forwarderStub.nonce.returnValues[0] as unknown as BigNumberish,
      };
      const {
        relayRequest: { request: actualRelayRequestBody },
      } = await relayClient._prepareRelayHttpRequest(
        {
          feesReceiver: constants.AddressZero,
        },
        FAKE_RELAY_REQUEST
      );

      expect(actualRelayRequestBody).to.deep.equal(expectedRelayRequestBody);
    });

    it('should return tx request with given relay request data + fees receiver from given hub info', async function () {
      const expectedRelayRequestData: UserDefinedRelayData = {
        ...FAKE_RELAY_REQUEST.relayData,
        feesReceiver: undefined,
      };
      const {
        relayRequest: { relayData: actualRelayRequestData },
      } = await relayClient._prepareRelayHttpRequest(
        {} as HubInfo,
        FAKE_RELAY_REQUEST
      );

      expect(actualRelayRequestData).to.deep.equal(expectedRelayRequestData);
    });

    it('should return tx request with updated fees receiver from given hub info', async function () {
      const expectedFeesReceiver = 'FAKE_RECEIVER';
      const {
        relayRequest: {
          relayData: { feesReceiver: actualFeesReceiver },
        },
      } = await relayClient._prepareRelayHttpRequest(
        { feesReceiver: expectedFeesReceiver } as HubInfo,
        FAKE_RELAY_REQUEST
      );

      expect(actualFeesReceiver).to.equal(expectedFeesReceiver);
    });

    // FIXME: find way to stub/mock config
    // it('should return tx request with updated call forwarder from config if one not given', async function () {
    //   const expectedCallForwarder = 'FAKE_CALL_FORWARDER';
    //   // const modifiedConfig: EnvelopingConfig = {
    //   //   ...FAKE_ENVELOPING_CONFIG,
    //   //   forwarderAddress: expectedCallForwarder,
    //   // };
    //   // // getConfigStub.returns(modifiedConfig);
    //   const {
    //     relayRequest: {
    //       relayData: { callForwarder: actualCallForwarder },
    //     },
    //   } = await relayClient._prepareRelayHttpRequest({} as HubInfo, {
    //     ...FAKE_RELAY_REQUEST,
    //     relayData: {
    //       callForwarder: undefined,
    //     } as unknown as EnvelopingRequestData,
    //   });

    //   expect(actualCallForwarder).to.equal(expectedCallForwarder);
    // });
    // it('should throw if no call forwarder given or configured', async function (){});

    it('should return relay metadata with relay hub address from request', async function () {
      const expectedRelayHubAddress = 'RELAY_HUB_ADDRESS';
      const {
        metadata: { relayHubAddress: actualRelayHubAddress },
      } = await relayClient._prepareRelayHttpRequest({} as HubInfo, {
        ...FAKE_RELAY_REQUEST,
        request: {
          ...FAKE_RELAY_REQUEST.request,
          relayHub: expectedRelayHubAddress,
        },
      });

      expect(actualRelayHubAddress).to.equal(expectedRelayHubAddress);
    });

    it('should sign the updated request', async function () {
      forwarderStub.nonce.resolves(0 as unknown as BigNumber);
      const signStub = accountManagerStub.sign;
      const expectedFeesReceiver = Wallet.createRandom().address;
      await relayClient._prepareRelayHttpRequest(
        {
          feesReceiver: expectedFeesReceiver,
        } as HubInfo,
        {
          ...FAKE_RELAY_REQUEST,
        }
      );

      expect(signStub).to.have.been.called;
      expect(signStub).to.have.been.calledWith({
        request: {
          ...FAKE_RELAY_REQUEST.request,
          nonce: await forwarderStub.nonce(),
        },
        relayData: {
          ...FAKE_RELAY_REQUEST.relayData,
          feesReceiver: expectedFeesReceiver,
        },
      } as RelayRequest);
    });

    it(`should emit sign request 'sign-request' `, async function () {
      const emitStub = sandbox.stub();
      (relayClient as unknown as EnvelopingEventEmitter).emit = emitStub;
      await relayClient._prepareRelayHttpRequest(
        {} as HubInfo,
        FAKE_RELAY_REQUEST
      );

      expect(emitStub).to.have.been.called;
      expect(emitStub).to.have.been.calledWith(
        envelopingEvents['sign-request']
      );
    });

    it('should return relay metadata with signature from account manager', async function () {
      const expectedSignature = FAKE_SIGNATURE;
      const {
        metadata: { signature: actualSignature },
      } = await relayClient._prepareRelayHttpRequest({} as HubInfo, {
        ...FAKE_RELAY_REQUEST,
        request: {
          ...FAKE_RELAY_REQUEST.request,
        },
      });

      expect(actualSignature).to.equal(expectedSignature);
    });
  });
});
