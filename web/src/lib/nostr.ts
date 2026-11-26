import { EventStore } from "applesauce-core";
import type {
    EventTemplate,
    NostrEvent,
    ProfileContent,
} from "applesauce-core/helpers";
import { bytesToHex, hexToBytes, normalizeToPubkey, npubEncode } from "applesauce-core/helpers";
import { createEventLoaderForStore } from "applesauce-loaders/loaders";
import { RelayPool } from "applesauce-relay";
import type { ISigner } from "applesauce-signers";
import {
    ExtensionSigner,
    NostrConnectSigner,
    PrivateKeySigner,
} from "applesauce-signers";
import { catchError, firstValueFrom, of, takeUntil, timer, toArray, filter, take } from "rxjs";
import {
    DEFAULT_NOSTR_READ_RELAYS,
    DEFAULT_OUTBOX_RELAYS,
    REQUIRED_PUBLIC_RELAYS,
} from "#lib/utils/relays";
import { ProfileCache, profileFromEvents } from "./utils/profile_cache";
import { MANAGEMENT_KIND, MANAGEMENT_READ_KIND } from "./utils/management";

export type NostrUser = {
    pubkey: string;
    npub: string;
};

export type NostrProfile = ProfileContent;
export type SignerKind = "extension" | "nostr-connect" | "amber";
export type ActiveSignerSummary = {
    kind: SignerKind;
    pubkey: string;
};
export type ActiveSigner = ActiveSignerSummary & {
    signer: ISigner;
};
export type NostrConnectSigninSession = {
    uri: string;
    waitForUser: (abort?: AbortSignal) => Promise<NostrUser>;
    cancel: () => void;
};
export type NostrConnectSigninOptions = {
    relays?: readonly string[];
    signerKind?: "nostr-connect" | "amber";
};

const PROFILE_LOAD_TIMEOUT_MS = 5000;
const SIGN_EVENT_TIMEOUT_MS = 60_000;
const REMOTE_LOGOUT_TIMEOUT_MS = 2500;
const SIGNER_SESSION_STORAGE_KEY = "keycast.signerSession.v1";
const SIGNER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_NOSTR_CONNECT_RELAYS = [
    ...REQUIRED_PUBLIC_RELAYS,
] as const;

type PersistedSignerSession =
    | {
          version: 1;
          kind: "extension";
          pubkey: string;
          expiresAt: number;
      }
    | {
          version: 1;
          kind: "nostr-connect" | "amber";
          pubkey: string;
          remote: string;
          relays: string[];
          clientKeyHex: string;
          expiresAt: number;
      };

export const eventStore = new EventStore();
export const relayPool = new RelayPool();
let activeSigner: ActiveSigner | null = null;
let restoringPromise: Promise<boolean> | null = null;
let signerEpoch = 0;
let signQueue: Promise<unknown> = Promise.resolve();

const loaderRelays = Array.from(
    new Set([...DEFAULT_NOSTR_READ_RELAYS, ...DEFAULT_OUTBOX_RELAYS]),
);

createEventLoaderForStore(eventStore, relayPool, {
    bufferTime: 1000,
    // Do not open connections to relays named inside fetched events.
    followRelayHints: false,
    extraRelays: [...DEFAULT_NOSTR_READ_RELAYS],
    lookupRelays: loaderRelays,
});

const profileCache = new ProfileCache(
    async (pubkey) => {
        const events = await firstValueFrom(
            relayPool.request(loaderRelays, { kinds: [0], authors: [pubkey], limit: 1 }).pipe(
                filter((event) => event.kind === 0 && event.pubkey === pubkey && event.content.length <= 64 * 1024),
                take(32),
                takeUntil(timer(PROFILE_LOAD_TIMEOUT_MS)),
                catchError(() => of()),
                toArray(),
            ),
        );
        return profileFromEvents(pubkey, events);
    },
    () => (typeof window === "undefined" ? undefined : window.localStorage),
);

export function normalizePubkey(pubkeyOrNpub: string): string | null {
    const input = pubkeyOrNpub.trim();
    if (!input) return null;

    try {
        return normalizeToPubkey(input);
    } catch {
        return null;
    }
}

export function userFromPubkey(pubkey: string | null | undefined): NostrUser | null {
    const normalized = pubkey ? normalizePubkey(pubkey) : null;
    if (!normalized) return null;

    return {
        pubkey: normalized,
        npub: npubEncode(normalized),
    };
}

export function npubForPubkey(pubkey: string | null | undefined): string | undefined {
    return userFromPubkey(pubkey)?.npub;
}

export function hasNip07Extension(): boolean {
    return typeof window !== "undefined" && !!window.nostr;
}

export function isAmberSigninSupported(): boolean {
    return (
        typeof navigator !== "undefined" &&
        /\bAndroid\b/i.test(navigator.userAgent)
    );
}

export function normalizeBunkerUri(uri: string): string {
    const normalized = uri.trim();
    if (!normalized.toLowerCase().startsWith("bunker://")) {
        throw new Error("Paste a bunker:// remote signer connection string");
    }
    let parsed: URL;
    try {
        parsed = new URL(normalized);
    } catch {
        throw new Error("Invalid bunker:// remote signer connection string");
    }
    if (parsed.username || parsed.password || parsed.hash) {
        throw new Error("Bunker URI must not contain credentials or fragments");
    }
    const relays = parsed.searchParams.getAll("relay");
    if (relays.length === 0 || relays.some((relay) => !isSafeRelayUrl(relay))) {
        throw new Error("Bunker URI must specify valid wss:// relay URLs");
    }

    return normalized;
}

export function buildNip46SigningPermissions(): string[] {
    return NostrConnectSigner.buildSigningPermissions([MANAGEMENT_KIND, MANAGEMENT_READ_KIND]);
}

export function getExtensionSigner(): ExtensionSigner {
    if (!hasNip07Extension()) {
        throw new Error("Install or enable a NIP-07 browser extension to sign in");
    }

    return new ExtensionSigner();
}

export async function getExtensionPubkey(): Promise<string> {
    const pubkey = normalizePubkey(await getExtensionSigner().getPublicKey());
    if (!pubkey) {
        throw new Error("The NIP-07 extension did not return a valid pubkey");
    }

    return pubkey;
}

export async function getExtensionUser(): Promise<NostrUser> {
    return userFromSigner(getExtensionSigner(), "extension", { persist: false });
}

export async function connectNostrConnectBunker(
    bunkerUri: string,
): Promise<NostrUser> {
    const safeUri = normalizeBunkerUri(bunkerUri);
    const signer = await NostrConnectSigner.fromBunkerURI(safeUri, {
        pool: relayPool,
        permissions: buildNip46SigningPermissions(),
        onAuth: openSignerAuthChallenge,
    });

    try {
        return await userFromSigner(signer, "nostr-connect", { persist: false });
    } catch (error) {
        disposeSigner(signer);
        throw error;
    }
}

export function createNostrConnectSigninSession(
    options: NostrConnectSigninOptions = {},
): NostrConnectSigninSession {
    const relays = (options.relays ?? DEFAULT_NOSTR_CONNECT_RELAYS).filter(isSafeRelayUrl);
    if (relays.length === 0) {
        throw new Error("No valid Nostr Connect relays configured");
    }
    const signerKind = options.signerKind ?? "nostr-connect";
    const signer = new NostrConnectSigner({
        relays: [...relays],
        pool: relayPool,
        onAuth: openSignerAuthChallenge,
    });
    enforceConnectSecretHandshake(signer);
    const uri = signer.getNostrConnectURI({
        name: "Keycast",
        url: browserOrigin(),
        permissions: buildNip46SigningPermissions(),
    });
    let promoted = false;

    return {
        uri,
        waitForUser: async (abort?: AbortSignal) => {
            try {
                await signer.waitForSigner(abort);
                const user = await userFromSigner(signer, signerKind, { persist: false });
                promoted = true;
                return user;
            } catch (error) {
                if (!promoted) {
                    disposeSigner(signer);
                }
                throw error;
            }
        },
        cancel: () => {
            if (!promoted) {
                disposeSigner(signer);
            }
        },
    };
}

/**
 * Upstream applesauce-signers accepts an unauthenticated `result === "ack"` during
 * `nostrconnect://` pairing even when `connectSecret` is set. Require an exact
 * match against `connectSecret` before allowing `this.remote` to be bound.
 */
function enforceConnectSecretHandshake(signer: NostrConnectSigner): void {
    const originalHandleEvent = signer.handleEvent.bind(signer);
    signer.handleEvent = async (event: NostrEvent) => {
        if (!signer.remote && signer.connectSecret) {
            if (!signer.verifyEvent(event)) return;
            let responseStr: string | undefined;
            try {
                const isNip04 = event.content.includes("?iv=");
                responseStr = isNip04
                    ? await signer.signer.nip04.decrypt(event.pubkey, event.content)
                    : await signer.signer.nip44.decrypt(event.pubkey, event.content);
            } catch {
                return;
            }
            if (!responseStr) return;
            let parsed: { result?: unknown };
            try {
                parsed = JSON.parse(responseStr) as { result?: unknown };
            } catch {
                return;
            }
            if (parsed.result !== signer.connectSecret) {
                return;
            }
        }
        return originalHandleEvent(event);
    };
}

export function setActiveSigner(
    next: ActiveSigner,
    options: { persist?: boolean } = {},
): ActiveSigner {
    const pubkey = normalizePubkey(next.pubkey);
    if (!pubkey) {
        throw new Error("Signer returned an invalid pubkey");
    }

    signerEpoch += 1;
    if (activeSigner?.signer !== next.signer) {
        disposeSigner(activeSigner?.signer);
    }

    activeSigner = {
        kind: next.kind,
        pubkey,
        signer: next.signer,
    };
    if (options.persist !== false) {
        persistSignerSession(activeSigner);
    }
    return activeSigner;
}

/** Persist the currently active signer after allowlist authorization succeeds. */
export function persistActiveSignerSession(): void {
    if (activeSigner) {
        persistSignerSession(activeSigner);
    }
}

export function clearActiveSigner(): void {
    signerEpoch += 1;
    disposeSigner(activeSigner?.signer);
    activeSigner = null;
    clearPersistedSignerSession();
}

/** Best-effort remote NIP-46 logout before local disposal and key zeroization. */
export async function logoutAndClearActiveSigner(): Promise<void> {
    const current = activeSigner;
    signerEpoch += 1;
    activeSigner = null;
    clearPersistedSignerSession();
    if (current?.signer instanceof NostrConnectSigner && current.signer.isConnected) {
        try {
            await Promise.race([
                current.signer.logout(),
                new Promise<void>((resolve) => setTimeout(resolve, REMOTE_LOGOUT_TIMEOUT_MS)),
            ]);
        } catch {
            // Best-effort remote revocation; always proceed to local cleanup.
        }
    }
    disposeSigner(current?.signer);
}

/** Drop only the in-memory signer instance (used in tests to simulate a reload). */
export function resetInMemorySignerForTest(): void {
    signerEpoch += 1;
    disposeSigner(activeSigner?.signer);
    activeSigner = null;
}

export function getActiveSignerSummary(): ActiveSignerSummary | null {
    if (!activeSigner) return null;

    return {
        kind: activeSigner.kind,
        pubkey: activeSigner.pubkey,
    };
}

/**
 * Restore a previously paired signer after a page reload without re-running
 * single-use bunker secrets or silently falling back to an unrelated extension.
 */
export async function restoreActiveSigner(expectedPubkey?: string | null): Promise<boolean> {
    const normalizedExpected = expectedPubkey ? normalizePubkey(expectedPubkey) : null;
    if (activeSigner) {
        return !normalizedExpected || activeSigner.pubkey === normalizedExpected;
    }
    if (restoringPromise) {
        const ok = await restoringPromise;
        return (
            ok &&
            (!normalizedExpected ||
                getActiveSignerSummary()?.pubkey === normalizedExpected)
        );
    }

    const startEpoch = signerEpoch;
    restoringPromise = (async () => {
        const stored = readPersistedSignerSession();
        if (!stored) return false;
        if (normalizedExpected && stored.pubkey !== normalizedExpected) {
            return false;
        }
        let candidate: NostrConnectSigner | null = null;
        try {
            if (stored.kind === "extension") {
                if (!hasNip07Extension()) return false;
                if (signerEpoch !== startEpoch) return false;
                activeSigner = {
                    kind: "extension",
                    pubkey: stored.pubkey,
                    signer: new ExtensionSigner(),
                };
                return true;
            }
            const clientSigner = new PrivateKeySigner(hexToBytes(stored.clientKeyHex));
            candidate = new NostrConnectSigner({
                relays: stored.relays,
                remote: stored.remote,
                pubkey: stored.pubkey,
                signer: clientSigner,
                pool: relayPool,
                onAuth: openSignerAuthChallenge,
            });
            // This client keypair is already paired with the remote signer; mark connected
            // and open the relay listener without re-sending a consumed one-time secret.
            candidate.isConnected = true;
            await candidate.open();
            if (signerEpoch !== startEpoch) {
                disposeSigner(candidate);
                return false;
            }
            activeSigner = {
                kind: stored.kind,
                pubkey: stored.pubkey,
                signer: candidate,
            };
            return true;
        } catch {
            // Preserve persisted session on transient network errors; dispose partial signer.
            disposeSigner(candidate);
            return false;
        }
    })();

    try {
        return await restoringPromise;
    } finally {
        restoringPromise = null;
    }
}

export async function signNostrEvent(
    template: EventTemplate,
    expectedPubkey?: string,
): Promise<NostrEvent> {
    const run = async (): Promise<NostrEvent> => {
        if (!activeSigner) {
            await restoreActiveSigner(expectedPubkey);
        }
        // After a reload the cookie can outlive the signer connection. Say so instead
        // of silently prompting whichever extension happens to be installed.
        if (!activeSigner) {
            throw new Error(
                "Your signer is no longer connected. Sign in again to approve this change.",
            );
        }
        const signer = activeSigner.signer;
        const normalizedExpectedPubkey = expectedPubkey
            ? normalizePubkey(expectedPubkey)
            : null;

        if (
            activeSigner &&
            normalizedExpectedPubkey &&
            activeSigner.pubkey !== normalizedExpectedPubkey
        ) {
            throw new Error("The active signer is connected to a different pubkey");
        }

        const signedEvent = await withTimeout(
            signer.signEvent(template),
            SIGN_EVENT_TIMEOUT_MS,
            "Signing request timed out waiting for your external signer.",
        );

        if (
            normalizedExpectedPubkey &&
            normalizePubkey(signedEvent.pubkey) !== normalizedExpectedPubkey
        ) {
            throw new Error("The signer signed with a different pubkey");
        }

        return signedEvent;
    };

    const next = signQueue.then(run, run);
    signQueue = next.then(
        () => undefined,
        () => undefined,
    );
    return next;
}

async function userFromSigner(
    signer: ISigner,
    kind: SignerKind,
    options: { persist?: boolean } = {},
): Promise<NostrUser> {
    const pubkey = normalizePubkey(await signer.getPublicKey());
    if (!pubkey) {
        throw new Error("The signer did not return a valid pubkey");
    }

    const user = userFromPubkey(pubkey);
    if (!user) {
        throw new Error("The signer did not return a valid pubkey");
    }

    setActiveSigner({ kind, signer, pubkey }, options);
    return user;
}

function disposeSigner(signer: ISigner | null | undefined): void {
    const disposable = signer as
        | {
              close?: () => Promise<void> | void;
              destroy?: () => void;
              signer?: { key?: unknown };
          }
        | null
        | undefined;

    if (disposable?.close) void disposable.close();
    disposable?.destroy?.();
    if (disposable?.signer?.key instanceof Uint8Array) {
        disposable.signer.key.fill(0);
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const handle = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            (value) => {
                clearTimeout(handle);
                resolve(value);
            },
            (error) => {
                clearTimeout(handle);
                reject(error);
            },
        );
    });
}

/**
 * The remote signer chooses this URL, so treat it as untrusted input: require
 * https and open with `noopener` so the popup cannot navigate this window to a
 * look-alike page while the operator is signing in.
 */
function openSignerAuthChallenge(url: string): Promise<void> {
    if (typeof window === "undefined") return Promise.resolve();

    let target: URL;
    try {
        target = new URL(url);
    } catch {
        return Promise.reject(new Error("The signer sent an invalid authorization URL"));
    }
    if (target.protocol !== "https:") {
        return Promise.reject(
            new Error(`The signer requested a non-HTTPS authorization URL (${target.protocol})`),
        );
    }

    window.open(
        target.href,
        "keycast-signer-auth",
        "noopener,noreferrer,width=420,height=640,resizable=yes,status=no,location=yes,toolbar=no,menubar=no",
    );
    return Promise.resolve();
}

function browserOrigin(): string | undefined {
    return typeof location === "undefined" ? undefined : location.origin;
}

function browserStorage(): Storage | null {
    if (typeof window === "undefined") return null;
    try {
        return window.sessionStorage ?? null;
    } catch {
        return null;
    }
}

function isSafeRelayUrl(value: unknown): value is string {
    if (typeof value !== "string" || !value.trim()) return false;
    try {
        const parsed = new URL(value);
        if (parsed.username || parsed.password || parsed.hash) return false;
        if (parsed.protocol === "wss:") return true;
        if (
            parsed.protocol === "ws:" &&
            (parsed.hostname === "localhost" ||
                parsed.hostname === "127.0.0.1" ||
                parsed.hostname === "[::1]")
        ) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

function persistSignerSession(active: ActiveSigner): void {
    const storage = browserStorage();
    if (!storage) return;
    const expiresAt = Date.now() + SIGNER_SESSION_TTL_MS;
    try {
        if (active.kind === "extension") {
            const payload: PersistedSignerSession = {
                version: 1,
                kind: "extension",
                pubkey: active.pubkey,
                expiresAt,
            };
            storage.setItem(SIGNER_SESSION_STORAGE_KEY, JSON.stringify(payload));
            return;
        }
        if (active.signer instanceof NostrConnectSigner && active.signer.remote) {
            const relays = active.signer.relays.filter(isSafeRelayUrl);
            if (!relays.length) return;
            const payload: PersistedSignerSession = {
                version: 1,
                kind: active.kind,
                pubkey: active.pubkey,
                remote: active.signer.remote,
                relays,
                clientKeyHex: bytesToHex(active.signer.signer.key),
                expiresAt,
            };
            storage.setItem(SIGNER_SESSION_STORAGE_KEY, JSON.stringify(payload));
        }
    } catch {
        // Storage may be unavailable in private browsing modes.
    }
}

function readPersistedSignerSession(): PersistedSignerSession | null {
    const storage = browserStorage();
    if (!storage) return null;
    try {
        const raw = storage.getItem(SIGNER_SESSION_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
            clearPersistedSignerSession();
            return null;
        }
        const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0;
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            clearPersistedSignerSession();
            return null;
        }
        const pubkey =
            typeof parsed.pubkey === "string" && /^[0-9a-f]{64}$/.test(parsed.pubkey)
                ? parsed.pubkey
                : null;
        if (!pubkey) {
            clearPersistedSignerSession();
            return null;
        }

        if (parsed.kind === "extension") {
            return { version: 1, kind: "extension", pubkey, expiresAt };
        }
        if (parsed.kind === "nostr-connect" || parsed.kind === "amber") {
            const remote =
                typeof parsed.remote === "string" && /^[0-9a-f]{64}$/.test(parsed.remote)
                    ? parsed.remote
                    : null;
            const clientKeyHex =
                typeof parsed.clientKeyHex === "string" &&
                /^[0-9a-f]{64}$/.test(parsed.clientKeyHex)
                    ? parsed.clientKeyHex
                    : null;
            const relays = Array.isArray(parsed.relays)
                ? parsed.relays.filter(isSafeRelayUrl)
                : [];
            if (!remote || !clientKeyHex || relays.length === 0) {
                clearPersistedSignerSession();
                return null;
            }
            return {
                version: 1,
                kind: parsed.kind,
                pubkey,
                remote,
                relays,
                clientKeyHex,
                expiresAt,
            };
        }
        clearPersistedSignerSession();
        return null;
    } catch {
        clearPersistedSignerSession();
        return null;
    }
}

function clearPersistedSignerSession(): void {
    const storage = browserStorage();
    if (!storage) return;
    try {
        storage.removeItem(SIGNER_SESSION_STORAGE_KEY);
    } catch {
        // Ignore storage errors on sign-out.
    }
}

export function getCachedProfile(pubkey: string): NostrProfile | null {
    const normalized = normalizePubkey(pubkey);
    return normalized ? profileCache.peek(normalized) : null;
}

export async function loadProfile(
    pubkey: string | null | undefined,
): Promise<NostrProfile | null> {
    const normalized = pubkey ? normalizePubkey(pubkey) : null;
    if (!normalized || typeof window === "undefined") return null;
    return profileCache.load(normalized);
}
