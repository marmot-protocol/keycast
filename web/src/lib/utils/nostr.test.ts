import { afterEach, describe, expect, test } from "bun:test";
import type { EventTemplate, NostrEvent } from "applesauce-core/helpers";
import { NostrConnectSigner, PrivateKeySigner } from "applesauce-signers";
import {
    buildNip46SigningPermissions,
    clearActiveSigner,
    createNostrConnectSigninSession,
    getActiveSignerSummary,
    npubForPubkey,
    normalizeBunkerUri,
    resetInMemorySignerForTest,
    restoreActiveSigner,
    setActiveSigner,
    signNostrEvent,
} from "#lib/nostr";
import { truncatedNpubForPubkey, userFromPubkeyOrNpub } from "./nostr";

const PUBKEY =
    "0000000000000000000000000000000000000000000000000000000000000001";
const OTHER_PUBKEY =
    "0000000000000000000000000000000000000000000000000000000000000002";

afterEach(() => {
    clearActiveSigner();
});

describe("Nostr helper utilities", () => {
    test("creates app users from hex pubkeys", () => {
        const npub = npubForPubkey(PUBKEY);
        expect(npub).toBeTruthy();

        expect(userFromPubkeyOrNpub(PUBKEY)).toEqual({
            pubkey: PUBKEY,
            npub: npub!,
        });
    });

    test("creates app users from npubs", () => {
        const npub = npubForPubkey(PUBKEY);

        expect(npub?.startsWith("npub1")).toBe(true);
        expect(userFromPubkeyOrNpub(npub || "")?.pubkey).toBe(PUBKEY);
    });

    test("rejects invalid pubkey input", () => {
        expect(userFromPubkeyOrNpub("not-a-pubkey")).toBeNull();
    });

    test("truncates npub output", () => {
        const npub = npubForPubkey(PUBKEY);

        expect(truncatedNpubForPubkey(PUBKEY, 12)).toBe(npub?.slice(0, 12));
    });

    test("normalizes bunker URIs before connecting remote signers", () => {
        expect(normalizeBunkerUri("  bunker://abc?relay=wss://relay.example  ")).toBe(
            "bunker://abc?relay=wss://relay.example",
        );

        expect(() => normalizeBunkerUri("nostrconnect://abc")).toThrow(
            "Paste a bunker:// remote signer connection string",
        );
        expect(() => normalizeBunkerUri("bunker://abc?relay=ws://evil.example")).toThrow(
            "valid wss:// relay URLs",
        );
        expect(() => normalizeBunkerUri("bunker://abc")).toThrow(
            "valid wss:// relay URLs",
        );
    });

    test("requests external signer permissions for both private management kinds", () => {
        expect(buildNip46SigningPermissions()).toEqual([
            "get_public_key",
            "sign_event:27236",
            "sign_event:27237",
        ]);
    });

    test("creates Amber sign-in sessions through Nostr Connect", () => {
        const session = createNostrConnectSigninSession({ signerKind: "amber" });
        const uri = new URL(session.uri);

        session.cancel();

        expect(uri.protocol).toBe("nostrconnect:");
        expect(uri.searchParams.get("perms")).toBe(
            "get_public_key,sign_event:27236,sign_event:27237",
        );
    });

    test("signs events with the active signer", async () => {
        const template = authTemplate();
        const signedEvent = signedAuthEvent(PUBKEY);

        setActiveSigner({
            kind: "extension",
            signer: {
                getPublicKey: async () => PUBKEY,
                signEvent: async () => signedEvent,
            },
            pubkey: PUBKEY,
        });

        await expect(signNostrEvent(template, PUBKEY)).resolves.toEqual(signedEvent);
        expect(getActiveSignerSummary()).toEqual({
            kind: "extension",
            pubkey: PUBKEY,
        });
    });

    test("rejects events signed by a different pubkey", async () => {
        setActiveSigner({
            kind: "amber",
            signer: {
                getPublicKey: async () => PUBKEY,
                signEvent: async () => signedAuthEvent(OTHER_PUBKEY),
            },
            pubkey: PUBKEY,
        });

        await expect(signNostrEvent(authTemplate(), PUBKEY)).rejects.toThrow(
            "signed with a different pubkey",
        );
    });

    test("persists and restores a paired NIP-46 bunker session across reloads without re-sending secrets", async () => {
        const store = new Map<string, string>();
        const prevWindow = (globalThis as Record<string, unknown>).window;
        (globalThis as Record<string, unknown>).window = {
            sessionStorage: {
                getItem: (key: string) => store.get(key) ?? null,
                setItem: (key: string, value: string) => store.set(key, value),
                removeItem: (key: string) => store.delete(key),
            },
        };
        try {
            const clientKey = new PrivateKeySigner();
            const original = new NostrConnectSigner({
                relays: ["wss://nos.lol"],
                remote: OTHER_PUBKEY,
                pubkey: PUBKEY,
                signer: clientKey,
                subscriptionMethod: () => ({ subscribe: () => ({ unsubscribe() {} }) }) as never,
                publishMethod: async () => [],
            });
            original.isConnected = true;

            setActiveSigner({
                kind: "nostr-connect",
                pubkey: PUBKEY,
                signer: original,
            });
            expect(store.size).toBe(1);
            // Must never store any bunker secret
            const saved = [...store.values()][0];
            expect(saved).not.toContain("bunkerSecret");

            // Simulate page refresh: clear in-memory activeSigner while storage remains
            resetInMemorySignerForTest();
            expect(getActiveSignerSummary()).toBeNull();

            // Mismatched pubkey is rejected
            await expect(restoreActiveSigner(OTHER_PUBKEY)).resolves.toBe(false);
            expect(getActiveSignerSummary()).toBeNull();

            // Matching pubkey restores cleanly
            await expect(restoreActiveSigner(PUBKEY)).resolves.toBe(true);
            expect(getActiveSignerSummary()).toEqual({
                kind: "nostr-connect",
                pubkey: PUBKEY,
            });

            // Sign-out wipes persisted session
            clearActiveSigner();
            expect(store.size).toBe(0);
            await expect(restoreActiveSigner(PUBKEY)).resolves.toBe(false);
        } finally {
            if (prevWindow === undefined) {
                delete (globalThis as Record<string, unknown>).window;
            } else {
                (globalThis as Record<string, unknown>).window = prevWindow;
            }
        }
    });
});

function authTemplate(): EventTemplate {
    return {
        kind: 27235,
        created_at: 1,
        content: "",
        tags: [["method", "GET"]],
    };
}

function signedAuthEvent(pubkey: string): NostrEvent {
    return {
        ...authTemplate(),
        id: `event-${pubkey}`,
        pubkey,
        sig: `sig-${pubkey}`,
    };
}
