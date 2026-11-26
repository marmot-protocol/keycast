<script lang="ts">
    import {
        resolveTeam,
        teamPath,
        teamSectionPath,
        workspaceSection,
    } from "#lib/utils/team_url";
    import { page } from "$app/state";
    import { goto } from "$app/navigation";
    import { getCurrentUser } from "#lib/current_user.svelte";
    import { KeycastApi } from "#lib/keycast_api.svelte";
    import type { Team, TeamWithRelations } from "#lib/types";
    import TeamWorkspace from "#lib/components/TeamWorkspace.svelte";
    import Loader from "#lib/components/Loader.svelte";
    import { Plus } from "phosphor-svelte";

    let { teamId }: { teamId?: string } = $props();
    const api = new KeycastApi();
    const user = $derived(getCurrentUser()?.user);
    let teams = $state<TeamWithRelations[]>([]);
    const selected = $derived(teamId);
    const section = $derived(
        workspaceSection(page.url.searchParams.get("section")),
    );
    let loading = $state(true);
    let startedFor = $state("");
    let error = $state("");
    let creating = $state(false);
    let busy = $state(false);
    let name = $state("");
    let createError = $state("");
    const activeTeam = $derived(resolveTeam(teams, selected));

    $effect(() => {
        if (user?.pubkey && startedFor !== user.pubkey) {
            startedFor = user.pubkey;
            teams = [];
            void load();
        }
    });

    $effect(() => {
        if (activeTeam?.team.slug && selected !== activeTeam.team.slug) {
            void goto(
                `${teamPath(activeTeam.team)}${page.url.search}${page.url.hash}`,
                { replaceState: true },
            );
        }
    });

    async function load() {
        if (!user) return;
        loading = true;
        error = "";
        try {
            const authorization = await api.buildAuthHeader(
                "/teams",
                "GET",
                user.pubkey,
            );
            teams = await api.get<TeamWithRelations[]>("/teams", {
                headers: { Authorization: authorization },
            });
            if (!teamId && teams[0]) {
                await goto(teamSectionPath(teams[0].team, section), {
                    replaceState: true,
                });
            }
        } catch (e) {
            error = e instanceof Error ? e.message : "Could not load teams";
        } finally {
            loading = false;
        }
    }

    async function createNamedTeam(teamName: string) {
        if (!user) return;
        const request = { name: teamName.trim() };
        const authorization = await api.buildAuthHeader(
            "/teams",
            "POST",
            user.pubkey,
            JSON.stringify(request),
        );
        const created = await api.post<TeamWithRelations>("/teams", request, {
            headers: { Authorization: authorization },
        });
        teams = [...teams, created];
        await goto(teamPath(created.team));
    }

    async function createFirstTeam() {
        if (!user || busy) return;
        busy = true;
        createError = "";
        try {
            await createNamedTeam(name);
            name = "";
            creating = false;
        } catch (e) {
            createError =
                e instanceof Error ? e.message : "Could not create team";
        } finally {
            busy = false;
        }
    }

    function switchTeam(target: Team) {
        void goto(teamSectionPath(target, section));
    }
</script>

<svelte:head>
    <title>
        {activeTeam
            ? `${activeTeam.team.name} — Keycast`
            : "Workspace — Keycast"}
    </title>
</svelte:head>

{#if loading}
    <Loader />
{:else if error}
    <div class="empty-state">
        <p class="input-error" role="alert">{error}</p>
        <button class="button button-secondary mt-3" onclick={load}
            >Retry</button
        >
    </div>
{:else if activeTeam}
    {#key `${user?.pubkey}:${activeTeam.team.id}`}
        <TeamWorkspace
            id={String(activeTeam.team.id)}
            initialTeam={activeTeam}
            allTeams={teams}
            {section}
            onSwitchTeam={switchTeam}
            onCreateTeam={createNamedTeam}
            onChanged={(updated) =>
                (teams = teams.map((item) =>
                    item.team.id === updated.team.id ? updated : item,
                ))}
            onDeleted={async () => {
                await goto("/teams", { replaceState: true });
            }}
        />
    {/key}
{:else if teamId}
    <div class="empty-state" role="alert">
        <h1 class="page-header">Team unavailable</h1>
        <p class="description mt-3">
            This team does not exist or your account does not have access.
        </p>
        <a href="/teams" class="button button-secondary mt-4">Go to your teams</a>
    </div>
{:else}
    <div class="max-w-lg">
        <p class="eyebrow mb-3">Your workspace starts here</p>
        <h1 class="page-header">A home for your keys.</h1>
        <p class="description mt-4">
            Create your first team to import keys, define access policies, and pair NIP-46 apps.
            A team can be just you, or the people you work with.
        </p>
        {#if creating}
            <form
                class="form-panel mt-6"
                onsubmit={(event) => {
                    event.preventDefault();
                    void createFirstTeam();
                }}
            >
                <div class="form-group">
                    <label for="first-team-name">Team name</label>
                    <input
                        id="first-team-name"
                        type="text"
                        required
                        maxlength="120"
                        bind:value={name}
                        placeholder="My workspace"
                    />
                </div>
                {#if createError}
                    <p role="alert" class="input-error mb-3">{createError}</p>
                {/if}
                <div class="form-actions">
                    <button class="button button-primary" disabled={busy}>
                        {busy ? "Creating…" : "Create team"}
                    </button>
                    <button
                        type="button"
                        class="button button-quiet"
                        onclick={() => (creating = false)}
                    >
                        Cancel
                    </button>
                </div>
            </form>
        {:else}
            <button
                type="button"
                class="button button-primary mt-6"
                onclick={() => (creating = true)}
            >
                <Plus size={16} /> Create a team
            </button>
        {/if}
    </div>
{/if}
