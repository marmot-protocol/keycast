<script lang="ts">
    import { goto } from "$app/navigation";
    import {
        teamSectionPath,
        type WorkspaceSection,
    } from "#lib/utils/team_url";
    import { onMount } from "svelte";
    import UserIdentity from "./UserIdentity.svelte";
    import { getCurrentUser } from "#lib/current_user.svelte";
    import { KeycastApi } from "#lib/keycast_api.svelte";
    import type {
        Team,
        TeamWithRelations,
        AuditEvent,
        Grant,
        GrantDiagnosticEvent,
        InvitationCreationResponse,
        Policy,
        User,
    } from "#lib/types";
    import KeyPanel from "./KeyPanel.svelte";
    import KeyImport from "./KeyImport.svelte";
    import ConnectionsTable from "./ConnectionsTable.svelte";
    import SigningLog from "./SigningLog.svelte";
    import MemberEditor from "./MemberEditor.svelte";
    import PolicyEditor from "./PolicyEditor.svelte";
    import PolicyCard from "./PolicyCard.svelte";
    import Loader from "./Loader.svelte";
    import {
        ArrowClockwise,
        ArrowRight,
        CaretDown,
        GearSix,
        HardDrives,
        Key,
        PlugsConnected,
        Plus,
        Pulse,
        ShieldCheck,
        Users,
    } from "phosphor-svelte";
    import {
        formattedDate,
        dateFromUnixSeconds,
    } from "#lib/utils/dates";
    import { grantState } from "#lib/utils/diagnostics";
    import { toast } from "svelte-hot-french-toast";

    let {
        id,
        initialTeam,
        allTeams = [],
        section = "keys",
        onSwitchTeam,
        onCreateTeam,
        onChanged,
        onDeleted,
    }: {
        id: string;
        initialTeam?: TeamWithRelations;
        allTeams?: TeamWithRelations[];
        section?: WorkspaceSection;
        onSwitchTeam?: (team: Team) => void;
        onCreateTeam?: (name: string) => Promise<void>;
        onChanged?: (team: TeamWithRelations) => void;
        onDeleted?: () => void;
    } = $props();

    const api = new KeycastApi();
    const user = $derived(getCurrentUser()?.user);
    let team = $state<TeamWithRelations | null>(null);
    let grants = $state<Grant[]>([]);
    let grantsError = $state("");
    let grantsLoading = $state(false);
    let events = $state<AuditEvent[]>([]);
    let diagnostics = $state<GrantDiagnosticEvent[]>([]);
    let auditError = $state("");
    let auditLoading = $state(true);

    let loading = $state(true);
    let error = $state("");
    let form = $state<"key" | "member" | "policy" | null>(null);
    let editingPolicy = $state<Policy | undefined>();
    let selectedKeyPubkey = $state<string | null>(null);
    let keyInitialTab = $state<"connections" | "log" | "relays" | "settings">("connections");
    let logFocusGrantId = $state<number | null>(null);
    let connectionInviteBanner = $state<{ grantName: string; uri: string } | null>(null);

    let switcherOpen = $state(false);
    let creatingTeam = $state(false);
    let newTeamName = $state("");
    let newTeamError = $state("");

    let busy = $state(false);
    let teamName = $state("");
    let nameError = $state("");
    let keyRevision = $state(0);
    let disposed = false;

    const admin = $derived(
        team?.team_users.some(
            (member) =>
                member.user_public_key === user?.pubkey &&
                member.role === "admin",
        ) ?? false,
    );

    const activeGrantsCount = $derived(
        grants.filter((g) => {
            const s = grantState(g);
            return s === "connected" || s === "awaiting_pairing" || s === "inactive";
        }).length,
    );
    const activeSessionsCount = $derived(
        grants.reduce((sum, g) => sum + g.active_sessions, 0),
    );
    const totalProblemsCount = $derived(
        diagnostics.length +
            events.filter((e) => e.outcome === "denied" || e.outcome === "failed")
                .length,
    );

    onMount(() => {
        if (initialTeam) {
            team = initialTeam;
            teamName = initialTeam.team.name;
            loading = false;
            void loadOperationalData();
        } else {
            void refresh();
        }
        return () => {
            disposed = true;
        };
    });

    // Leaving "keys" clears the selected key detail so clicking Keys returns to list unless jumped explicitly.
    $effect(() => {
        if (section !== "keys") {
            selectedKeyPubkey = null;
        }
    });

    async function read<T>(endpoint: string): Promise<T> {
        if (!user) throw new Error("Sign in to load this workspace.");
        const authorization = await api.buildAuthHeader(
            endpoint,
            "GET",
            user.pubkey,
        );
        return api.get<T>(endpoint, {
            headers: { Authorization: authorization },
        });
    }

    async function loadOperationalData() {
        auditLoading = true;
        grantsLoading = admin;
        auditError = "";
        grantsError = "";
        const tasks: Promise<void>[] = [
            read<AuditEvent[]>(`/teams/${id}/audit`)
                .then((data) => {
                    if (!disposed) events = data;
                })
                .catch((e) => {
                    if (!disposed)
                        auditError =
                            e instanceof Error
                                ? e.message
                                : "Activity could not be loaded";
                }),
        ];
        if (admin) {
            tasks.push(
                read<Grant[]>(`/teams/${id}/grants`)
                    .then((data) => {
                        if (!disposed) grants = data;
                    })
                    .catch((e) => {
                        if (!disposed)
                            grantsError =
                                e instanceof Error
                                    ? e.message
                                    : "Connections could not be loaded";
                    }),
                read<GrantDiagnosticEvent[]>(`/teams/${id}/diagnostics`)
                    .then((data) => {
                        if (!disposed) diagnostics = data;
                    })
                    .catch(() => {
                        if (!disposed) diagnostics = [];
                    }),
            );
        }
        await Promise.all(tasks);
        if (!disposed) {
            auditLoading = false;
            grantsLoading = false;
        }
    }

    async function refresh() {
        loading = true;
        error = "";
        try {
            const loaded = await read<TeamWithRelations>(`/teams/${id}`);
            if (disposed) return;
            team = loaded;
            teamName = loaded.team.name;
            keyRevision += 1;
            onChanged?.(team);
            await loadOperationalData();
        } catch (e) {
            error =
                e instanceof Error
                    ? e.message
                    : "Workspace could not be loaded";
        } finally {
            loading = false;
        }
    }

    async function handleCreateTeam() {
        if (!onCreateTeam || busy) return;
        const trimmed = newTeamName.trim();
        if (!trimmed) return;
        busy = true;
        newTeamError = "";
        try {
            await onCreateTeam(trimmed);
            newTeamName = "";
            creatingTeam = false;
            switcherOpen = false;
        } catch (e) {
            newTeamError = e instanceof Error ? e.message : "Could not create team";
        } finally {
            busy = false;
        }
    }

    async function renameTeam() {
        if (!user || !team || !admin || busy || loading) return;
        const name = teamName.trim();
        nameError = "";
        if (!name || [...name].length > 120) {
            nameError = "Use between 1 and 120 characters.";
            return;
        }
        if (name === team.team.name) return;
        busy = true;
        try {
            const endpoint = `/teams/${id}`;
            const request = { name };
            const authorization = await api.buildAuthHeader(
                endpoint,
                "PUT",
                user.pubkey,
                JSON.stringify(request),
            );
            const updated = await api.put<Team>(endpoint, request, {
                headers: { Authorization: authorization },
            });
            if (disposed) return;
            team = { ...team, team: updated };
            teamName = updated.name;
            onChanged?.(team);
            toast.success("Team name updated");
            void loadOperationalData();
        } catch (e) {
            if (!disposed)
                nameError =
                    e instanceof Error
                        ? e.message
                        : "Could not update the team name.";
        } finally {
            busy = false;
        }
    }

    async function saved() {
        form = null;
        editingPolicy = undefined;
        await refresh();
    }

    function toggleForm(next: "key" | "member" | "policy") {
        form = form === next ? null : next;
        editingPolicy = undefined;
    }

    function jumpToEditPolicy(policyId: number) {
        const target = team?.policies.find((p) => p.id === policyId);
        if (!target || !team) return;
        editingPolicy = target;
        form = "policy";
        void goto(teamSectionPath(team.team, "policies"));
    }

    function openKeyDetail(
        pubkey: string,
        tab: "connections" | "log" | "relays" | "settings" = "connections",
        grantId: number | null = null,
    ) {
        selectedKeyPubkey = pubkey;
        keyInitialTab = tab;
        logFocusGrantId = grantId;
    }

    function inspectGrantInLog(grant: Grant) {
        logFocusGrantId = grant.id;
        if (team) {
            void goto(teamSectionPath(team.team, "activity"));
        }
    }

    async function openKeyFromConnections(pubkey: string) {
        if (!team) return;
        await goto(teamSectionPath(team.team, "keys"));
        openKeyDetail(pubkey, "connections");
    }

    async function createInvitationForGrant(grant: Grant) {
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
            connectionInviteBanner = {
                grantName: grant.name,
                uri: response.bunker_uri,
            };
            toast.success("One-time invitation created");
            await loadOperationalData();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not create invitation");
        }
    }

    async function revokeGrantFromTable(grant: Grant) {
        if (
            !user?.pubkey ||
            !grant.stored_key_public_key ||
            !confirm("Revoke this connection and all of its active sessions?")
        )
            return;
        try {
            const endpoint = `/teams/${id}/keys/${grant.stored_key_public_key}/grants/${grant.id}`;
            const authorization = await api.buildAuthHeader(
                endpoint,
                "DELETE",
                user.pubkey,
            );
            await api.delete(endpoint, { headers: { Authorization: authorization } });
            toast.success("Connection revoked");
            await loadOperationalData();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not revoke connection");
        }
    }

    async function remove(
        endpoint: string,
        question: string,
        success: () => void | Promise<void>,
    ) {
        if (!user || busy || !confirm(question)) return;
        busy = true;
        try {
            const authorization = await api.buildAuthHeader(
                endpoint,
                "DELETE",
                user.pubkey,
            );
            await api.delete(endpoint, {
                headers: { Authorization: authorization },
            });
            await success();
        } catch (e) {
            toast.error(
                e instanceof Error
                    ? e.message
                    : "Could not complete this action",
            );
        } finally {
            busy = false;
        }
    }

    async function removeMember(member: User) {
        await remove(
            `/teams/${id}/users/${member.user_public_key}`,
            "Remove this member from the team?",
            refresh,
        );
    }

    async function removePolicy(policy: Policy) {
        await remove(
            `/teams/${id}/policies/${policy.id}`,
            `Delete policy “${policy.name}”?`,
            refresh,
        );
    }

    function keyMetrics(keyId: number) {
        const keyGrants = grants.filter((g) => g.stored_key_id === keyId);
        const activeGrants = keyGrants.filter((g) => {
            const s = grantState(g);
            return s === "connected" || s === "awaiting_pairing" || s === "inactive";
        });
        const sessions = keyGrants.reduce((sum, g) => sum + g.active_sessions, 0);
        const drops = diagnostics.filter((d) => d.stored_key_id === keyId).length;
        const denials = events.filter(
            (e) =>
                e.stored_key_id === keyId &&
                (e.outcome === "denied" || e.outcome === "failed"),
        ).length;
        return {
            activeGrants: activeGrants.length,
            totalGrants: keyGrants.length,
            sessions,
            problems: drops + denials,
            drops,
        };
    }
</script>

{#if loading && !team}
    <Loader />
{:else if !team}
    <div class="empty-state">
        <p role="alert" class="input-error">{error}</p>
        <button class="button button-secondary mt-3" onclick={refresh}
            >Retry</button
        >
    </div>
{:else}
    <div class="utility-shell">
        <aside class="utility-sidebar" aria-label="Workspace navigation">
            <!-- Compact Team Switcher (replaces the second sidebar) -->
            <div class="team-switcher-wrap">
                <button
                    type="button"
                    class="team-switcher-btn"
                    aria-expanded={switcherOpen}
                    onclick={() => (switcherOpen = !switcherOpen)}
                >
                    <span class="min-w-0 text-left">
                        <span class="block text-sm font-semibold truncate">{team.team.name}</span>
                        <span class="block text-[11px] text-muted font-mono">
                            {admin ? "team admin" : "member"} · {team.stored_keys.length} {team.stored_keys.length === 1 ? "key" : "keys"}
                        </span>
                    </span>
                    <CaretDown size={14} class="shrink-0 text-muted" />
                </button>

                {#if switcherOpen}
                    <div class="team-switcher-menu">
                        <p class="eyebrow px-2 pt-1 pb-2">Switch team</p>
                        {#each allTeams as item (item.team.id)}
                            <button
                                type="button"
                                class="switcher-item"
                                class:active={item.team.id === team.team.id}
                                onclick={() => {
                                    switcherOpen = false;
                                    onSwitchTeam?.(item.team);
                                }}
                            >
                                <span class="truncate">{item.team.name}</span>
                                <small>{item.stored_keys.length}k</small>
                            </button>
                        {/each}
                        {#if onCreateTeam}
                            <div class="border-t border-line mt-2 pt-2">
                                {#if creatingTeam}
                                    <form
                                        class="px-1 flex flex-col gap-2"
                                        onsubmit={(e) => {
                                            e.preventDefault();
                                            void handleCreateTeam();
                                        }}
                                    >
                                        <input
                                            type="text"
                                            required
                                            maxlength="120"
                                            placeholder="New team name"
                                            bind:value={newTeamName}
                                        />
                                        {#if newTeamError}
                                            <p class="input-error text-xs">{newTeamError}</p>
                                        {/if}
                                        <div class="flex gap-1.5">
                                            <button class="button button-primary grow" disabled={busy}>
                                                {busy ? "Creating…" : "Create"}
                                            </button>
                                            <button
                                                type="button"
                                                class="button button-quiet"
                                                onclick={() => (creatingTeam = false)}
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </form>
                                {:else}
                                    <button
                                        type="button"
                                        class="switcher-item"
                                        onclick={() => (creatingTeam = true)}
                                    >
                                        <span class="inline-flex items-center gap-1.5">
                                            <Plus size={13} /> Create new team
                                        </span>
                                    </button>
                                {/if}
                            </div>
                        {/if}
                    </div>
                {/if}
            </div>

            <nav class="utility-nav" aria-label="Team sections">
                <p class="nav-group-label">Signing</p>
                <a
                    class="section-choice"
                    class:active={section === "keys"}
                    data-section="keys"
                    href={teamSectionPath(team.team, "keys")}
                    aria-current={section === "keys" ? "page" : undefined}
                    onclick={() => (selectedKeyPubkey = null)}
                >
                    <Key size={15} />
                    <span>Keys</span>
                    <small>{team.stored_keys.length}</small>
                </a>
                <a
                    class="section-choice"
                    class:active={section === "connections"}
                    data-section="connections"
                    href={teamSectionPath(team.team, "connections")}
                    aria-current={section === "connections" ? "page" : undefined}
                >
                    <PlugsConnected size={15} />
                    <span>Connections</span>
                    {#if admin}<small>{activeGrantsCount}</small>{/if}
                </a>
                <a
                    class="section-choice"
                    class:active={section === "policies"}
                    data-section="policies"
                    href={teamSectionPath(team.team, "policies")}
                    aria-current={section === "policies" ? "page" : undefined}
                >
                    <ShieldCheck size={15} />
                    <span>Policies</span>
                    <small>{team.policies.length}</small>
                </a>
                <a
                    class="section-choice"
                    class:active={section === "activity"}
                    data-section="activity"
                    href={teamSectionPath(team.team, "activity")}
                    aria-current={section === "activity" ? "page" : undefined}
                    onclick={() => (logFocusGrantId = null)}
                >
                    <Pulse size={15} />
                    <span>Signing Log</span>
                    {#if totalProblemsCount > 0}
                        <span class="pill-count-danger">{totalProblemsCount}</span>
                    {/if}
                </a>

                <p class="nav-group-label mt-4">Team</p>
                <a
                    class="section-choice"
                    class:active={section === "members"}
                    data-section="members"
                    href={teamSectionPath(team.team, "members")}
                    aria-current={section === "members" ? "page" : undefined}
                >
                    <Users size={15} />
                    <span>Members</span>
                    <small>{team.team_users.length}</small>
                </a>
                <a
                    class="section-choice"
                    class:active={section === "settings"}
                    data-section="settings"
                    href={teamSectionPath(team.team, "settings")}
                    aria-current={section === "settings" ? "page" : undefined}
                >
                    <GearSix size={15} />
                    <span>Team Settings</span>
                </a>
            </nav>

            <div class="sidebar-server-box">
                <p class="nav-group-label">Server</p>
                <a class="section-choice" href="/status">
                    <HardDrives size={15} />
                    <span>Instance</span>
                </a>
            </div>
        </aside>

        <div class="utility-main">
            {#if error}<p role="alert" class="input-error mb-3">{error}</p>{/if}

            {#if section === "keys"}
                {#if admin && selectedKeyPubkey}
                    {#key `${keyRevision}:${selectedKeyPubkey}`}
                        <KeyPanel
                            {id}
                            pubkey={selectedKeyPubkey}
                            policies={team.policies}
                            auditEvents={events}
                            {diagnostics}
                            initialTab={keyInitialTab}
                            initialGrantId={logFocusGrantId}
                            onBack={() => (selectedKeyPubkey = null)}
                            onRemoved={async () => {
                                selectedKeyPubkey = null;
                                await refresh();
                            }}
                            onChanged={loadOperationalData}
                            onRefreshLogs={loadOperationalData}
                            onEditPolicy={jumpToEditPolicy}
                        />
                    {/key}
                {:else}
                    <section class="section !mt-0" aria-label="Managed keys">
                        <div class="section-heading">
                            <div>
                                <h2>Keys <span>{team.stored_keys.length}</span></h2>
                                <p class="description mt-1">
                                    Select a key to manage its NIP-46 app connections, invitations, paired sessions, and signing trace.
                                </p>
                            </div>
                            <div class="flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    class="button button-secondary"
                                    onclick={refresh}
                                    disabled={loading || busy}
                                >
                                    <ArrowClockwise size={14} /> Refresh
                                </button>
                                {#if admin}
                                    <button
                                        type="button"
                                        class="button button-primary"
                                        aria-expanded={form === "key"}
                                        onclick={() => toggleForm("key")}
                                    >
                                        <Plus size={14} />{form === "key"
                                            ? "Close import"
                                            : "Import key"}
                                    </button>
                                {/if}
                            </div>
                        </div>

                        {#if admin && team.stored_keys.length > 0}
                            <div class="utility-summary-bar">
                                <a class="summary-tile" href={teamSectionPath(team.team, "keys")}>
                                    <strong>{team.stored_keys.length}</strong>
                                    <span>Signing {team.stored_keys.length === 1 ? "key" : "keys"}</span>
                                </a>
                                <a class="summary-tile" href={teamSectionPath(team.team, "connections")}>
                                    <strong>{activeGrantsCount}</strong>
                                    <span>Active {activeGrantsCount === 1 ? "connection" : "connections"} ({activeSessionsCount} paired)</span>
                                </a>
                                <a class="summary-tile" href={teamSectionPath(team.team, "policies")}>
                                    <strong>{team.policies.length}</strong>
                                    <span>Access {team.policies.length === 1 ? "policy" : "policies"}</span>
                                </a>
                                <a class="summary-tile" href={teamSectionPath(team.team, "activity")}>
                                    <strong class:text-danger={totalProblemsCount > 0}>{totalProblemsCount}</strong>
                                    <span>Recent denials &amp; drops</span>
                                </a>
                            </div>
                        {/if}

                        {#if form === "key"}
                            <div class="form-panel">
                                <KeyImport {id} onSaved={saved} />
                            </div>
                        {/if}

                        {#if !team.stored_keys.length}
                            <div class="empty-state">
                                No signing keys in <strong>{team.team.name}</strong> yet.
                                Import a Nostr key, define an access policy, then connect your first app or CLI.
                            </div>
                        {:else}
                            <div class="key-card-list">
                                {#each team.stored_keys as key (key.public_key)}
                                    {@const metrics = keyMetrics(key.id)}
                                    {#if admin}
                                        <button
                                            type="button"
                                            class="key-list-card"
                                            onclick={() => openKeyDetail(key.public_key)}
                                        >
                                            <div class="min-w-0 grow">
                                                <div class="flex items-center gap-2 flex-wrap mb-2">
                                                    <span class="text-sm font-semibold">{key.name}</span>
                                                    <span class="badge badge-neutral">
                                                        {metrics.activeGrants} {metrics.activeGrants === 1 ? "connection" : "connections"}
                                                    </span>
                                                    {#if metrics.sessions > 0}
                                                        <span class="badge">
                                                            {metrics.sessions} paired
                                                        </span>
                                                    {/if}
                                                    {#if metrics.problems > 0}
                                                        <span class="badge badge-danger">
                                                            {metrics.problems} {metrics.problems === 1 ? "issue" : "issues"}
                                                        </span>
                                                    {/if}
                                                </div>
                                                <UserIdentity pubkey={key.public_key} />
                                            </div>
                                            <div class="key-list-right">
                                                <span class="text-xs text-muted">
                                                    Added {formattedDate(dateFromUnixSeconds(key.created_at))}
                                                </span>
                                                <span class="open-key-cta">
                                                    Manage <ArrowRight size={14} />
                                                </span>
                                            </div>
                                        </button>
                                    {:else}
                                        <div class="key-list-card">
                                            <div class="min-w-0 grow">
                                                <span class="block text-sm font-semibold mb-2">{key.name}</span>
                                                <UserIdentity pubkey={key.public_key} />
                                            </div>
                                            <span class="text-xs text-muted">
                                                Added {formattedDate(dateFromUnixSeconds(key.created_at))}
                                            </span>
                                        </div>
                                    {/if}
                                {/each}
                            </div>
                            {#if !admin}
                                <p class="description mt-4">
                                    You are a team member. Ask a team administrator to create or inspect NIP-46 app connections for these keys.
                                </p>
                            {/if}
                        {/if}
                    </section>
                {/if}
            {:else if section === "connections"}
                {#if admin}
                    <ConnectionsTable
                        teamId={id}
                        keys={team.stored_keys}
                        policies={team.policies}
                        {grants}
                        {diagnostics}
                        auditEvents={events}
                        loading={grantsLoading}
                        error={grantsError}
                        invitationBanner={connectionInviteBanner}
                        onDismissBanner={() => (connectionInviteBanner = null)}
                        onOpenKey={openKeyFromConnections}
                        onInspectGrant={inspectGrantInLog}
                        onCreateInvitation={createInvitationForGrant}
                        onRevokeGrant={revokeGrantFromTable}
                        onCreated={loadOperationalData}
                    />
                {:else}
                    <div class="empty-state">
                        Only team administrators can view or manage NIP-46 connections and invitations.
                    </div>
                {/if}
            {:else if section === "policies"}
                <section class="section !mt-0" aria-label="Access policies">
                    <div class="section-heading">
                        <div>
                            <h2>Policies <span>{team.policies.length}</span></h2>
                            <p class="description mt-1">
                                Reusable permission sets attached to connections. Everything not explicitly permitted is denied.
                            </p>
                        </div>
                        {#if admin}
                            <button
                                type="button"
                                class="button button-primary"
                                aria-expanded={form === "policy"}
                                onclick={() => toggleForm("policy")}
                            >
                                <Plus size={14} />{form === "policy"
                                    ? "Close editor"
                                    : "New policy"}
                            </button>
                        {/if}
                    </div>
                    {#if form === "policy"}
                        <div class="form-panel">
                            {#key editingPolicy?.id}
                                <PolicyEditor
                                    {id}
                                    policy={editingPolicy}
                                    onSaved={saved}
                                />
                            {/key}
                        </div>
                    {/if}
                    {#if !team.policies.length}
                        <div class="empty-state">
                            Define what connected apps can sign or encrypt. Policies are default-deny and apply immediately across any connection using them.
                        </div>
                    {:else}
                        <div class="flex flex-col gap-3">
                            {#each team.policies as policy (policy.id)}
                                <div class="card">
                                    <PolicyCard
                                        {policy}
                                        usedByGrants={grants.filter((g) => g.policy_id === policy.id)}
                                        onEdit={admin
                                            ? (item) => {
                                                  editingPolicy = item;
                                                  form = "policy";
                                              }
                                            : undefined}
                                        onRemove={admin ? removePolicy : undefined}
                                    />
                                </div>
                            {/each}
                        </div>
                    {/if}
                </section>
            {:else if section === "activity"}
                <section class="section !mt-0" aria-label="Signing log and diagnostics">
                    <div class="section-heading">
                        <div>
                            <h2>Signing Log &amp; Diagnostics</h2>
                            <p class="description mt-1">
                                Durable audit log combined with live in-memory pre-admission drops (reused secrets, unpaired clients, decrypt failures).
                            </p>
                        </div>
                    </div>
                    <SigningLog
                        auditEvents={events}
                        {diagnostics}
                        keys={team.stored_keys}
                        {grants}
                        policies={team.policies}
                        initialGrantId={logFocusGrantId}
                        loading={auditLoading}
                        error={auditError}
                        onRefresh={loadOperationalData}
                        onEditPolicy={admin ? jumpToEditPolicy : undefined}
                    />
                </section>
            {:else if section === "members"}
                <section class="section !mt-0" aria-label="Team members">
                    <div class="section-heading">
                        <div>
                            <h2>Members <span>{team.team_users.length}</span></h2>
                            <p class="description mt-1">
                                <strong>Admins</strong> manage keys, policies, connections, and invitations. <strong>Members</strong> have read-only visibility into the team and its audit log.
                            </p>
                        </div>
                        {#if admin}
                            <button
                                type="button"
                                class="button button-primary"
                                aria-expanded={form === "member"}
                                onclick={() => toggleForm("member")}
                            >
                                <Plus size={14} />{form === "member"
                                    ? "Close form"
                                    : "Add member"}
                            </button>
                        {/if}
                    </div>
                    {#if form === "member"}
                        <div class="form-panel">
                            <MemberEditor {id} onSaved={saved} />
                        </div>
                    {/if}
                    <div class="border-t border-line">
                        {#each team.team_users as member (member.user_public_key)}
                            <div class="member-row">
                                <div class="min-w-0 grow">
                                    <UserIdentity
                                        pubkey={member.user_public_key}
                                        isYou={member.user_public_key === user?.pubkey}
                                    />
                                    <p class="text-muted text-[11px] mt-1">
                                        Joined {formattedDate(dateFromUnixSeconds(member.created_at))}
                                    </p>
                                </div>
                                <span
                                    class="badge"
                                    class:badge-neutral={member.role !== "admin"}
                                >
                                    {member.role}
                                </span>
                                {#if admin}
                                    <button
                                        type="button"
                                        class="button button-danger"
                                        disabled={busy}
                                        aria-label={`Remove member ${member.user_public_key}`}
                                        onclick={() => removeMember(member)}
                                    >
                                        Remove
                                    </button>
                                {/if}
                            </div>
                        {/each}
                    </div>
                </section>
            {:else if section === "settings"}
                <section class="section !mt-0" aria-label="Team settings">
                    <div class="section-heading">
                        <h2>Team Settings</h2>
                    </div>
                    {#if admin}
                        <form
                            class="border-t border-line pt-5 pb-6"
                            onsubmit={(event) => {
                                event.preventDefault();
                                void renameTeam();
                            }}
                        >
                            <label class="eyebrow" for="workspace-name">Team name</label>
                            <div class="flex flex-wrap items-start gap-3 mt-2 max-w-xl">
                                <input
                                    id="workspace-name"
                                    class="grow min-w-0 basis-56"
                                    type="text"
                                    required
                                    maxlength="120"
                                    bind:value={teamName}
                                    disabled={busy || loading}
                                    aria-invalid={nameError ? true : undefined}
                                    aria-describedby={nameError ? "workspace-name-error" : "workspace-name-help"}
                                />
                                <button
                                    class="button button-primary"
                                    type="submit"
                                    disabled={busy || loading || !teamName.trim() || teamName.trim() === team.team.name}
                                >
                                    {busy ? "Saving…" : "Save name"}
                                </button>
                            </div>
                            <p id="workspace-name-help" class="description mt-2">
                                Your team’s URL stays the same when you rename it.
                            </p>
                            {#if nameError}
                                <p id="workspace-name-error" class="input-error mt-2" role="alert">{nameError}</p>
                            {/if}
                        </form>
                    {/if}
                    <dl class="team-settings-info">
                        {#if !admin}
                            <div>
                                <dt class="eyebrow">Team name</dt>
                                <dd>{team.team.name}</dd>
                            </div>
                        {/if}
                        <div>
                            <dt class="eyebrow">Created</dt>
                            <dd>{formattedDate(dateFromUnixSeconds(team.team.created_at))}</dd>
                        </div>
                    </dl>
                    {#if admin}
                        <div class="mt-8 border-t border-line pt-5">
                            <h3 class="text-sm font-semibold mb-2">Delete team</h3>
                            <p class="description mb-4">
                                Permanently deletes this team, removes its keys, and revokes every attached connection and session.
                            </p>
                            <button
                                type="button"
                                class="button button-danger"
                                disabled={busy}
                                onclick={() =>
                                    remove(
                                        `/teams/${id}`,
                                        "Permanently delete this team, its keys, and all attached access?",
                                        () => onDeleted?.(),
                                    )}
                            >
                                Delete team
                            </button>
                        </div>
                    {:else}
                        <p class="description mt-6">
                            Only team administrators can change team settings.
                        </p>
                    {/if}
                </section>
            {/if}
        </div>
    </div>
{/if}
