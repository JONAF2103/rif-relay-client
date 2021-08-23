## Rif Relay Client

This typescript repository contains all the client code used by the Rif Relay System.
This project works as a dependency and needs to be installed in order to be used.

### Pre-Requisites

* Node version 12.18

#### How to start

To start working with this project you need to enable `postinstall` scripts, refer to section [Enable postinstall scripts](#enable-postinstall-scripts) to know how to do it. Then just run `npm install` to install all dependencies.

#### How to use it

You can use this dependency once you have it installed on your project. You have a few
ways to installing this dependency:

* **Use a release version:** just install this using the install command for node `npm i --save @rsksmart/rif-relay-client`.
* **Use the distributable directly from the repository:** modify your `package.json` file
  to add this line `"@rsksmart/rif-relay-client": "https://github.com/infuy/rif-relay-client",`
* **Use the development version directly from your changes:** clone this repository next to your project and modify your `package.json` file
  to add this line `"@rsksmart/rif-relay-client": "../rif-relay-client",`
  
After you install this dependency you can use the RelayClient, RelayProvider or the Enveloping class to interact with the Rif Relay Server.

#### Using the RelayProvider for web3

Another option is to use Enveloping through a Relay Provider. The latter wraps web3, and then all transactions and calls are made through the Relay Provider. If a Relay Client is not provided then the Relay Provider creates an instance.

```typescript
    import { RelayProvider, resolveConfiguration } from "@rsksmart/rif-relay-client";
    import Web3 from "web3";

    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

    const web3 = new Web3("http://localhost:4444");
    
    const smartWalletFactoryAbi = {};// some json containing the abi of the smart wallet factory contract.
    const smartWalletFactoryAddress = "0x3bA95e1cccd397b5124BcdCC5bf0952114E6A701"; // the smart wallet factort contract address (can be retrieved from the summary of the deployment).
    const smartWalletIndex = 0; // the index of the smart wallet

    const smartWalletAddress = await new web3.eth.Contract(
        smartWalletFactoryAbi,
        smartWalletFactoryAddress
    ).methods.getSmartWalletAddress(
        account.address,
        ZERO_ADDRESS,
        smartWalletIndex
    ).call();
    
    const relayVerifierAddress = "0x74Dc4471FA8C8fBE09c7a0C400a0852b0A9d04b2"; // the relay verifier contract address (can be retrieved from the summary of the deployment).
    const deployVerifierAddress = "0x1938517B0762103d52590Ca21d459968c25c9E67"; // the deploy verifier contract address (can be retrieved from the summary of the deployment).

    const config = await resolveConfiguration(web3.currentProvider,
        {
            verbose: window.location.href.includes("verbose"),
            onlyPreferredRelays: true,
            preferredRelays: ["http://localhost:8090"],
            factory: smartWalletFactoryAddress,
            gasPriceFactorPercent: 0,
            relayLookupWindowBlocks: 1e5,
            chainId: 33,
            relayVerifierAddress,
            deployVerifierAddress,
            smartWalletFactoryAddress
        });
        resolvedConfig.relayHubAddress = "0x3bA95e1cccd397b5124BcdCC5bf0952114E6A701"; // the relay hub contract address (can be retrieved from the summary of the deployment).

    const provider = new RelayProvider(web3.currentProvider, config);
    
    provider.addAccount(account);

    web3.setProvider(provider);
    
    const tokenContract = "0x0E569743F573323F430B6E14E5676EB0cCAd03D9"; // token address to use on smart wallet
    const tokenAmount = "100"; // total token amount for the smart wallet, the smart wallet address should have more than this number before calling the deploy.

    // deploy smart wallet
    const deployTransaction = await provider.deploySmartWallet({
        from: account.address,
        to: ZERO_ADDRESS,
        gas: "0x27100",
        value: "0",
        callVerifier: deployVerifierAddress,
        callForwarder: smartWalletFactoryAddress,
        tokenContract,
        tokenAmount,
        data: "0x",
        index: smartWalletIndex,
        recoverer: ZERO_ADDRESS,
        isSmartWalletDeploy: true,
        onlyPreferredRelays: true,
        smartWalletAddress
    });
    
    // relay transaction
    const unsigned_tx = {
        // some common web3 transaction with the common parameters.
    };

    const tokenAmountForRelay = "10";
    
    const relayTransaction = web3.eth.sendTransaction({
        from: account.address,
        callVerifier: relayVerifierAddress,
        callForwarder: smartWalletAddress,
        isSmartWalletDeploy: false,
        onlyPreferredRelays: true,
        tokenAmount: tokenAmountForRelay,
        tokenContract,
        ...unsigned_tx,
    });
```

**Note: in the example above the `account` object is assumed as an object containing the address (as string) and
the privateKey (as buffer)**

Before running this example, you need to know a few requirements:

1. The smart wallet address generated by the contract call should be funded with tokens before running the deploy call or
   you can set tokenAmount to 0 (or remove it) to make a subsidized deploy instead.
2. The token address you use need to be explicitly allowed. To do so, make a call to the contracts involved to allow them to work with your particular token. These contracts are the relay and deploy verifiers, and the method is `acceptToken`, it should be called
   with the contract deployer account.
   Only the owner of the contracts can do that, but if you are running this in regtest, then the accounts[0]
   is the owner.
   You can allow tokens by calling the relay verifier and deploy verifier (for both wallets, smart wallet and custom smart wallet) contracts manually with web3.
   You have an example of how to allow tokens [here](https://github.com/anarancio/rif-relay-contracts/blob/master/scripts/allowTokens)
   
#### Using the Enveloping Utils as a library

An advantage of the Enveloping's solution is the chance to have a token's wallet without deploying it. When a user needs to use tokens, needs to deploy the smart wallet using a deploy request. Thereby, when a gas-less account sent a transaction through Enveloping, they could use their smart wallet address to pay for the gas.

As a simplification of the process, the Enveloping Utils is provided to use as a library. It simplifies the process to create an smart wallet and therefore relay a transaction. It gives the chance to the developers to propose their provider to sign the transaction. The functions that the developer should code on the provider are `sign` and `verifySign`.

```typescript


//Initialize the Enveloping Utils
import { Enveloping } from '@rsksmart/rif-relay-client'
const partialConfig: Partial<EnvelopingConfig> =
    {
      relayHubAddress: relayHub.address,
      smartWalletFactoryAddress: factory.address,
      chainId: chainId,
      relayVerifierAddress: relayVerifier.address,  // The verifier that will verify the relayed transaction
      deployVerifierAddress: deployVerifier.address, // The verifier that will verify the smart wallet deployment
      preferredRelays: ['http://localhost:8090'], //If there is a preferred relay server.
    };
    config = configure(partialConfig);
    enveloping = new Enveloping(config, web3, workerAddress);
    await enveloping._init();

//Instances a signature provider: This is just for test, please DO NOT use in production.

const signatureProvider: SignatureProvider = {
    sign: (dataToSign: TypedRequestData, privKey?: Buffer) => {
      // @ts-ignore
      return sigUtil.signTypedData_v4(privKey, { data: dataToSign })
    },
    verifySign: (signature: PrefixedHexString, dataToSign: TypedRequestData, request: RelayRequest|DeployRequest) => {
      // @ts-ignore
      const rec = sigUtil.recoverTypedSignature_v4({
        data: dataToSign,
        sig: signature
      })
      return isSameAddress(request.request.from, rec)
    }
  };

//Deploying a Smart Wallet
const deployRequest = await enveloping.createDeployRequest(senderAddress, deploymentGasLimit, tokenContract, tokenAmount, tokenGas, gasPrice, index);
const deploySignature = enveloping.signDeployRequest(signatureProvider, deployRequest);
const httpDeployRequest = await enveloping.generateDeployTransactionRequest(deploySignature, deployRequest);
const sentDeployTransaction = await enveloping.sendTransaction(localhost, httpDeployRequest);
sentDeployTransaction.transaction?.hash(true).toString('hex'); //This is used to get the transaction hash

const encodedFunction = testRecipient.contract.methods.emitMessage('hello world').encodeABI();
const relayRequest = await enveloping.createRelayRequest(gaslessAccount.address, testRecipient.address, smartWalletAddress, encodedFunction, gasLimit, tokenContract, tokenAmount, tokenGas);
const relaySignature = enveloping.signRelayRequest(signatureProvider, relayRequest, gaslessAccount.privateKey);
const httpRelayRequest = await enveloping.generateRelayTransactionRequest(relaySignature, relayRequest);
const sentRelayTransaction = await enveloping.sendTransaction(localhost, httpRelayRequest);
sentRelayTransaction.transaction?.hash(true).toString('hex'); //This is used to get the transaction hash
```

#### How to generate a new distributable version

1. Bump the version on the `package.json` file.
2. Commit and push any changes included the bump.

#### For Github

1. Run `npm pack` to generate the tarball to be publish as release on github.
2. Generate a new release on github and upload the generated tarball.

#### For NPM

1. Run `npm login` to login to your account on npm registry.
2. Run `npm publish` to generate the distributable version for NodeJS

#### For direct use

1. Run `npm run dist` to generate the distributable version.
2. Commit and push the dist folder with the updated version to the repository on master.

**IMPORTANT: when you publish a version postinstall scripts must be disabled. This is disabled by default, don't push any changes to the postinstall scripts section in the `package.json` file.**

#### How to develop

If you need to modify resources inside this repository the first thing you need to do always is to make sure you have `postinstall` scripts enabled on the `package.json`. These
are disabled by default due to distribution issues. (This will be solve in the future). This will enable husky and other checks,
then run `npm install` to execute the post install hooks. After that you can just make your modifications
and then run `npm run build` to validate them. After you are done with your changes you
can publish them by creating a distributable version for the consumers.

#### Enable postinstall scripts

To enable `postinstall` scripts you need to modify the `package.json` file
in the section `scripts` and change the line `"_postinstall": "scripts/postinstall",`
to `"postinstall": "scripts/postinstall",`.

#### Husky and linters

We use husky to check linters and code styles on commits, if you commit your
changes and the commit fails on lint or prettier checks you can use these command
to check and fix the errors before trying to commit again:

* `npm run lint`: to check linter bugs
* `npm run lint:fix`: to fix linter bugs
* `npm run prettier`: to check codestyles errors
* `npm run prettier:fix`: to fix codestyles errors
