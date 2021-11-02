import { KnownRelaysManager } from './KnownRelaysManager';
import HttpClient from './HttpClient';
import { PingFilter } from './types/Aliases';
import { EnvelopingConfig, EnvelopingTransactionDetails } from '@rsksmart/rif-relay-common';
import { RelayManagerData } from '@rsksmart/rif-relay-contracts';
import { PartialRelayInfo, RelayInfo } from './types/RelayInfo';
export interface RaceResult {
    winner?: PartialRelayInfo;
    errors: Map<string, Error>;
}
export default class RelaySelectionManager {
    private readonly knownRelaysManager;
    private readonly httpClient;
    private readonly config;
    private readonly pingFilter;
    private readonly transactionDetails;
    private remainingRelays;
    private isInitialized;
    errors: Map<string, Error>;
    constructor(transactionDetails: EnvelopingTransactionDetails, knownRelaysManager: KnownRelaysManager, httpClient: HttpClient, pingFilter: PingFilter, config: EnvelopingConfig);
    /**
     * Ping those relays that were not pinged yet, and remove both the returned relay or relays re from {@link remainingRelays}
     * @returns the first relay to respond to a ping message. Note: will never return the same relay twice.
     */
    selectNextRelay(): Promise<RelayInfo | undefined>;
    _getPreferredRelaysNextSlice(index: number): RelayManagerData[];
    _nextRelayInternal(relays: RelayManagerData[]): Promise<RelayInfo | undefined>;
    init(): Promise<this>;
    relaysLeft(): RelayManagerData[];
    _getNextSlice(): RelayManagerData[];
    /**
     * @returns JSON response from the relay server, but adds the requested URL to it :'-(
     */
    _getRelayAddressPing(relayInfo: RelayManagerData): Promise<PartialRelayInfo>;
    /**
     * From https://stackoverflow.com/a/37235207 (added types, modified to catch exceptions)
     * Accepts an array of promises.
     * Resolves once any promise resolves, ignores the rest. Exceptions returned separately.
     */
    _raceToSuccess(relays: RelayManagerData[]): Promise<RaceResult>;
    _handleRaceResults(raceResult: RaceResult): void;
}
