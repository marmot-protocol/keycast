<script lang="ts">
    import { goto } from "$app/navigation";
    import GrantEditor from "#lib/components/GrantEditor.svelte";
    import Copy from "#lib/components/Copy.svelte";
    import PublicKeyDetails from "#lib/components/PublicKeyDetails.svelte";
    import GrantCard from "#lib/components/GrantCard.svelte";
    import SigningLog from "#lib/components/SigningLog.svelte";
    import Loader from "#lib/components/Loader.svelte";
    import { getCurrentUser } from "#lib/current_user.svelte";
    import { KeycastApi } from "#lib/keycast_api.svelte";
    import type {
        AuditEvent,
        Grant,
        GrantDiagnosticEvent,
        InvitationCreationResponse,
        KeyWithRelations,
        KeyRelayInfo,
        Policy,
        StoredKey,
        Team,
    } from "#lib/types";
    import { formattedDate, dateFromUnixSeconds } from "#lib/utils/dates";
    import { grantState } from "#lib/utils/diagnostics";
    import { npubForPubkey } from "#lib/nostr";
    import { ArrowClockwise, ArrowLeft, CaretDown, CaretRight, Plus } from "phosphor-svelte";
    import { toast } from "svelte-hot-french-toast";

    let {
        id,
        pubkey,
        policies = [],
        auditEvents = [],
        diagnostics = [],
        initialTab = "connections",
        initialGrantId = null,
        onBack,
        onRemoved,
        onChanged,
        onEditPolicy,
        onRefreshLogs,
    }: {
        id: string;
        pubkey: string;
        policies?: Policy[];
        auditEvents?: AuditEvent[];
        diagnostics?: GrantDiagnosticEvent[];
        initialTab?: "connections" | "log" | "relays" | "settings";
        initialGrantId?: number | null;
        onBack?: () => void;
        onRemoved?: () => void | Promise<void>;
        onChanged?: () => void | Promise<void>;
        onEditPolicy?: (policyId: number) => void;
        onRefreshLogs?: () => void | Promise<void>;
    } = $props();

    // A crafted link can put anything in the route parameter, which would then be
    // signed into the `u` tag of an approval the operator is asked to confirm.
    const invalidPubkey = $derived(!/^[0-9a-f]{64}$/.test(pubkey));
    let activeTab = $state<"connections" | "log" | "relays" | "settings">("connections");
    let focusedGrantId = $state<number | null>(null);
    let addingGrant = $state(false);
    let showRevoked = $state(false);
    let started = $state(false);
    const api = new KeycastApi();
    const user = $derived(getCurrentUser()?.user);
    let isLoading = $state(true);
    let team = $state<Team | null>(null);
    let key = $state<StoredKey | null>(null);
    let grants = $state<Grant[]>([]);
    let relayDiscovery = $state<KeyRelayInfo | null>(null);
    let localAudit = $state<AuditEvent[]>([]);
    let localDiagnostics = $state<GrantDiagnosticEvent[]>([]);
    let localPolicies = $state<Policy[]>([]);
    let invitationBanner = $state<{ grantName: string; uri: string } | null>(null);
    let loadError = $state<string | null>(null);

    const effectivePolicies = $derived(policies.length > 0 ? policies : localPolicies);
    const effectiveAudit = $derived(auditEvents.length > 0 || onRefreshLogs ? auditEvents : localAudit);
    const effectiveDiagnostics = $derived(
        diagnostics.length > 0 || onRefreshLogs ? diagnostics : localDiagnostics,
    );
    const policyById = $derived(new Map(effectivePolicies.map((p) => [p.id, p])));
    const npub = $derived(key ? npubForPubkey(key.public_key) ?? key.public_key : "");
    const activeGrants = $derived(
        grants.filter((g) => {
            const status = grantState(g);
            return status !== "revoked" && status !== "expired";
        }),
    );
    const archivedGrants = $derived(
        grants.filter((g) => {
            const status = grantState(g);
            return status === "revoked" || status === "expired";
        }),
    );
    const activeGrantsCount = $derived(activeGrants.length);
    const activeSessionsCount = $derived(
        activeGrants.reduce((sum, g) => sum + g.active_sessions, 0),
    );
    const keyProblemsCount = $derived.by(() => {
        if (!key) return 0;
        const dropCount = effectiveDiagnostics.filter((d) => d.stored_key_id === key!.id).length;
        const deniedCount = effectiveAudit.filter(
            (e) =>
                e.stored_key_id === key!.id &&
                (e.outcome === "denied" || e.outcome === "failed"),
        ).length;
        return dropCount + deniedCount;
    });

    $effect(() => {
        activeTab = initialTab;
    });

    $effect(() => {
        if (initialGrantId !== null) {
            focusedGrantId = initialGrantId;
        }
    });

    $effect(() => {
        if (!user?.pubkey || started || invalidPubkey) return;
        started = true;
        void load();
    });

    async function load() {
        if (!user?.pubkey) return;
        isLoading = true;
        loadError = null;
        try {
            const endpoint = `/teams/${id}/keys/${pubkey}`;
            const authorization = await api.buildAuthHeader(
                endpoint,
                "GET",
                user.pubkey,
            );
            const response = await api.get<KeyWithRelations>(endpoint, {
                headers: { Authorization: authorization },
            });
            key = response.stored_key;
            team = response.team;
            grants = response.grants;
            relayDiscovery = response.relay_discovery;

            // Standalone route fallback (when opened directly at /teams/:id/keys/:pubkey)
            if (!onRefreshLogs) {
                const [teamData, auditData, diagData] = await Promise.all([
                    api
                        .buildAuthHeader(`/teams/${id}`, "GET", user.pubkey)
                        .then((auth) =>
                            api.get<{ policies: Policy[] }>(`/teams/${id}`, {
                                headers: { Authorization: auth },
                            }),
                        )
                        .catch(() => null),
                    api
                        .buildAuthHeader(`/teams/${id}/audit`, "GET", user.pubkey)
                        .then((auth) =>
                            api.get<AuditEvent[]>(`/teams/${id}/audit`, {
                                headers: { Authorization: auth },
                            }),
                        )
                        .catch(() => []),
                    api
                        .buildAuthHeader(`/teams/${id}/diagnostics`, "GET", user.pubkey)
                        .then((auth) =>
                            api.get<GrantDiagnosticEvent[]>(`/teams/${id}/diagnostics`, {
                                headers: { Authorization: auth },
                            }),
                        )
                        .catch(() => []),
                ]);
                if (teamData) localPolicies = teamData.policies;
                localAudit = auditData;
                localDiagnostics = diagData;
            }
        } catch (error) {
            loadError =
                error instanceof Error ? error.message : String(error);
        } finally {
            isLoading = false;
        }
    }

    async function refreshAll() {
        await Promise.all([load(), onRefreshLogs?.()]);
    }

    async function removeKey() {
        if (
            !user?.pubkey ||
            !confirm(
                "Remove this key and revoke every connection and session attached to it?",
            )
        )
            return;
        try {
            const endpoint = `/teams/${id}/keys/${pubkey}`;
            const authorization = await api.buildAuthHeader(
                endpoint,
                "DELETE",
                user.pubkey,
            );
            await api.delete(endpoint, {
                headers: { Authorization: authorization },
            });
            toast.success("Key removed");
            if (onRemoved) await onRemoved();
            else await goto(`/teams/${id}`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        }
    }

    async function revokeGrant(grant: Grant) {
        if (
            !user?.pubkey ||
            !confirm("Revoke this connection and all of its active sessions?")
        )
            return;
        try {
            const endpoint = `/teams/${id}/keys/${pubkey}/grants/${grant.id}`;
            const authorization = await api.buildAuthHeader(
                endpoint,
                "DELETE",
                user.pubkey,
            );
            await api.delete(endpoint, {
                headers: { Authorization: authorization },
            });
            toast.success("Connection revoked");
            await load();
            await onChanged?.();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        }
    }

    async function createInvitation(grant: Grant) {
        if (!user?.pubkey) return;
        try {
            const endpoint = `/teams/${id}/grants/${grant.id}/invitations`;
            const request = {
                expires_at: Math.min(
                    Math.floor(Date.now() / 1000) + 24 * 3600,
                    grant.expires_at ?? Infinity,
                ),
            };
            const body = JSON.stringify(request);
            const authorization = await api.buildAuthHeader(
                endpoint,
                "POST",
                user.pubkey,
                body,
            );
            const response = await api.post<InvitationCreationResponse>(
                endpoint,
                request,
                { headers: { Authorization: authorization } },
            );
            invitationBanner = {
                grantName: grant.name,
                uri: response.bunker_uri,
            };
            toast.success("One-time invitation created");
            await load();
            await onChanged?.();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        }
    }

    async function revokeInvitation(grant: Grant, invitationId: number) {
        if (!user?.pubkey) return;
        try {
            const endpoint = `/teams/${id}/invitations/${invitationId}`;
            const authorization = await api.buildAuthHeader(
                endpoint,
                "DELETE",
                user.pubkey,
            );
            await api.delete(endpoint, {
                headers: { Authorization: authorization },
            });
            invitationBanner = null;
            toast.success("Invitation revoked; active sessions are unchanged");
            await load();
            await onChanged?.();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        }
    }

    function inspectGrant(grant: Grant) {
        focusedGrantId = grant.id;
        activeTab = "log";
    }
</script>

{#if invalidPubkey}
    <div role="alert">
        <p class="input-error">
            That is not a valid Nostr public key. Open the key from your
            workspace instead of following the link.
        </p>
    </div>
{:else if isLoading && !key}
    <Loader />
{:else if loadError && !key}
    <div role="alert">
        <p class="input-error">{loadError}</p>
        <button class="button button-secondary mt-3" onclick={load}
            >Retry</button
        >
    </div>
{:else if team && key}
    <div class="key-detail-shell">
        {#if loadError}
            <p class="input-error" role="alert">{loadError}</p>
        {/if}
        <div class="key-detail-header">
            <div class="min-w-0">
                {#if onBack}
                    <button
                        type="button"
                        class="back-link mb-2"
                        onclick={onBack}
                    >
                        <ArrowLeft size={13} /> All keys in {team.name}
                    </button>
                {/if}
                <h2 class="page-header !mb-1">{key.name}</h2>
                <div class="flex flex-wrap items-center gap-2 text-xs text-muted font-mono">
                    <span class="truncate max-w-[36ch]" title={npub}>{npub}</span>
                    <Copy value={npub} size="13" label="Copy npub" />
                    <span>·</span>
                    <span>{activeGrantsCount} active {activeGrantsCount === 1 ? "connection" : "connections"}</span>
                    <span>·</span>
                    <span>{activeSessionsCount} paired {activeSessionsCount === 1 ? "session" : "sessions"}</span>
                </div>
            </div>
            <div class="flex flex-wrap gap-2">
                <button
                    type="button"
                    class="button button-secondary"
                    onclick={refreshAll}
                    disabled={isLoading}
                >
                    <ArrowClockwise size={14} /> Refresh
                </button>
                <button
                    type="button"
                    class="button button-primary"
                    aria-expanded={addingGrant}
                    onclick={() => {
                        activeTab = "connections";
                        addingGrant = !addingGrant;
                    }}
                >
                    <Plus size={14} />{addingGrant ? "Close form" : "Connect app"}
                </button>
            </div>
        </div>

        <nav class="subtabs" aria-label="Key sections">
            <button
                type="button"
                class="subtab"
                class:active={activeTab === "connections"}
                onclick={() => (activeTab = "connections")}
            >
                Connections <span class="subtab-count">{activeGrants.length}</span>
            </button>
            <button
                type="button"
                class="subtab"
                class:active={activeTab === "log"}
                onclick={() => (activeTab = "log")}
            >
                Signing Log
                {#if keyProblemsCount > 0}
                    <span class="pill-count-danger">{keyProblemsCount}</span>
                {/if}
            </button>
            <button
                type="button"
                class="subtab"
                class:active={activeTab === "relays"}
                onclick={() => (activeTab = "relays")}
            >
                Relays
                {#if relayDiscovery}
                    <span class="subtab-count">{relayDiscovery.relays.length}</span>
                {/if}
            </button>
            <button
                type="button"
                class="subtab"
                class:active={activeTab === "settings"}
                onclick={() => (activeTab = "settings")}
            >
                Key Settings
            </button>
        </nav>

        {#if activeTab === "connections"}
            {#if invitationBanner}
                <div class="invitation">
                    <h3 class="text-sm font-semibold mb-1">
                        One-time invitation for {invitationBanner.grantName}
                    </h3>
                    <p class="description mb-3">
                        Copy this <code>bunker://</code> URL now — Keycast stores only a hash of its secret. Clients pair once and keep their client key (for <code>nak</code>, use a persistent <code>--connect-as</code> / <code>NOSTR_CLIENT_KEY</code>).
                    </p>
                    <div class="font-mono text-xs break-all flex items-center gap-2 bg-canvas p-3 rounded-md border border-line">
                        <span class="grow select-all">{invitationBanner.uri}</span>
                        <Copy value={invitationBanner.uri} label="Copy bunker URI" />
                    </div>
                    <button
                        type="button"
                        class="button button-secondary mt-3"
                        onclick={() => (invitationBanner = null)}
                    >
                        Dismiss
                    </button>
                </div>
            {/if}

            {#if addingGrant}
                <div class="form-panel">
                    <GrantEditor
                        {id}
                        {pubkey}
                        availableKeys={[key]}
                        availablePolicies={effectivePolicies.length > 0 ? effectivePolicies : undefined}
                        onDone={async () => {
                            addingGrant = false;
                            await load();
                            await onChanged?.();
                        }}
                    />
                </div>
            {/if}

            {#if activeGrants.length === 0 && archivedGrants.length === 0}
                <div class="empty-state">
                    No apps connected to <strong>{key.name}</strong> yet.
                    Click <strong>Connect app</strong> to choose a policy and generate a one-time <code>bunker://</code> invitation.
                </div>
            {:else}
                {#if activeGrants.length > 0}
                    <div class="flex flex-col gap-3">
                        {#each activeGrants as grant (grant.id)}
                            <GrantCard
                                {grant}
                                policy={policyById.get(grant.policy_id)}
                                drops={effectiveDiagnostics.filter((d) => d.grant_id === grant.id)}
                                onRevoke={revokeGrant}
                                onCreateInvitation={createInvitation}
                                onRevokeInvitation={revokeInvitation}
                                onInspectLog={inspectGrant}
                                {onEditPolicy}
                            />
                        {/each}
                    </div>
                {:else}
                    <div class="empty-state">
                        No active connections on <strong>{key.name}</strong>.
                        Click <strong>Connect app</strong> to pair a new client, or expand the revoked connections below.
                    </div>
                {/if}

                {#if archivedGrants.length > 0}
                    <div class="archived-section">
                        <button
                            type="button"
                            class="button button-secondary button-sm"
                            aria-expanded={showRevoked}
                            onclick={() => (showRevoked = !showRevoked)}
                        >
                            {#if showRevoked}
                                <CaretDown size={12} />
                                Hide revoked &amp; expired ({archivedGrants.length})
                            {:else}
                                <CaretRight size={12} />
                                Show revoked &amp; expired ({archivedGrants.length})
                            {/if}
                        </button>

                        {#if showRevoked}
                            <div class="flex flex-col gap-3 mt-3">
                                {#each archivedGrants as grant (grant.id)}
                                    <GrantCard
                                        {grant}
                                        policy={policyById.get(grant.policy_id)}
                                        drops={effectiveDiagnostics.filter((d) => d.grant_id === grant.id)}
                                        onRevoke={revokeGrant}
                                        onCreateInvitation={createInvitation}
                                        onRevokeInvitation={revokeInvitation}
                                        onInspectLog={inspectGrant}
                                        {onEditPolicy}
                                    />
                                {/each}
                            </div>
                        {/if}
                    </div>
                {/if}
            {/if}
        {:else if activeTab === "log"}
            <SigningLog
                auditEvents={effectiveAudit}
                diagnostics={effectiveDiagnostics}
                keys={[key]}
                {grants}
                policies={effectivePolicies}
                lockedKeyId={key.id}
                initialGrantId={focusedGrantId}
                loading={isLoading}
                onRefresh={refreshAll}
                {onEditPolicy}
            />
        {:else if activeTab === "relays"}
            <section class="card">
                <div class="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h3 class="text-sm font-semibold">NIP-65 relay discovery for {key.name}</h3>
                        <p class="description mt-1">
                            Your instance’s baseline signing relays are always active for this key.
                            NIP-65 discovery is optional and only adds extra public relays advertised by this key’s kind 10002 list.
                        </p>
                    </div>
                    <button
                        type="button"
                        class="button button-secondary"
                        onclick={load}
                        disabled={isLoading}
                    >
                        <ArrowClockwise size={14} /> Refresh
                    </button>
                </div>

                {#if relayDiscovery}
                    <div class="text-xs font-mono text-muted border-t border-line pt-3">
                        Discovery status: <strong>{relayDiscovery.status}</strong>
                        {#if relayDiscovery.fetched_at}
                            · last checked {new Date(relayDiscovery.fetched_at * 1000).toLocaleString()}
                        {/if}
                    </div>

                    {#if !relayDiscovery.auto_activate}
                        <p class="text-xs text-muted bg-canvas border border-line p-3">
                            <strong>Optional auto-activation is off.</strong> Baseline signing relays still handle all NIP-46 traffic for this key.
                            An instance operator can enable automatic NIP-65 relay activation in <a href="/status" class="bordered">Instance</a>.
                        </p>
                    {/if}

                    {#each relayDiscovery.relays as relay (relay.url)}
                        <div class="flex flex-wrap justify-between gap-2 border-t border-line py-2 text-xs">
                            <span class="font-mono break-all">{relay.url}</span>
                            <span class="text-muted">
                                {relay.read ? "read" : ""}{relay.read && relay.write ? " / " : ""}{relay.write ? "write" : ""}
                                · {relay.active ? "signer active" : relay.status}
                                {!relay.listed ? " · retiring" : ""}
                            </span>
                        </div>
                    {:else}
                        <p class="text-xs text-muted border-t border-line pt-3">
                            {relayDiscovery.status === "pending"
                                ? "Checking this key’s NIP-65 relay list in the background."
                                : "No usable NIP-65 relay list found. Your configured baseline signing relays remain active."}
                        </p>
                    {/each}
                {/if}
            </section>
        {:else if activeTab === "settings"}
            <div class="flex flex-col gap-5">
                <div class="card">
                    <PublicKeyDetails pubkey={key.public_key} />
                    <p class="text-xs text-muted border-t border-line pt-3">
                        Added to {team.name} on {formattedDate(dateFromUnixSeconds(key.created_at))}.
                    </p>
                </div>

                <div class="card border-danger-line">
                    <h3 class="text-sm font-semibold">Remove key</h3>
                    <p class="description">
                        Permanently removes this encrypted key from Keycast and immediately revokes all {activeGrants.length} active {activeGrants.length === 1 ? "connection" : "connections"} and sessions attached to it.
                    </p>
                    <div>
                        <button
                            type="button"
                            class="button button-danger"
                            onclick={removeKey}
                        >
                            Remove key
                        </button>
                    </div>
                </div>
            </div>
        {/if}
    </div>
{/if}
