import type { DatabaseSync } from "node:sqlite";

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

const MIGRATIONS: string[] = [
  `
  create table projects (
    id text primary key,
    name text not null,
    local_path text not null unique,
    github_repo text,
    default_branch text not null default 'main',
    test_cmd text,
    lint_cmd text,
    created_at text not null default ${NOW}
  );

  create table sessions (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    title text not null,
    status text not null default 'active' check (status in ('active','archived')),
    created_at text not null default ${NOW}
  );
  create index sessions_project on sessions(project_id, created_at);

  create table tasks (
    id text primary key,
    session_id text not null references sessions(id) on delete cascade,
    project_id text not null references projects(id) on delete cascade,
    prompt text not null,
    status text not null default 'queued' check (status in (
      'queued','planning','coding','checking','reviewing','awaiting_approval',
      'pushing','done','rejected','needs_human','failed','cancelled')),
    plan text,
    branch text,
    base_branch text,
    commit_sha text,
    pr_url text,
    review_rounds integer not null default 0,
    error text,
    claimed_by text,
    created_at text not null default ${NOW},
    updated_at text not null default ${NOW}
  );
  create index tasks_status on tasks(status, created_at);
  create index tasks_session on tasks(session_id, created_at);

  create table agent_runs (
    id text primary key,
    task_id text not null references tasks(id) on delete cascade,
    role text not null check (role in ('planner','coder','reviewer','git','memory')),
    provider text,
    model text,
    dsh_session_id text,
    status text not null default 'running' check (status in ('running','succeeded','failed','cancelled')),
    started_at text not null default ${NOW},
    ended_at text
  );
  create index agent_runs_task on agent_runs(task_id);

  create table events (
    id integer primary key autoincrement,
    task_id text not null references tasks(id) on delete cascade,
    run_id text references agent_runs(id) on delete set null,
    type text not null,
    payload text not null default '{}',
    created_at text not null default ${NOW}
  );
  create index events_task on events(task_id, id);

  create table approvals (
    id text primary key,
    task_id text not null references tasks(id) on delete cascade,
    kind text not null check (kind in ('push_and_pr','permission')),
    summary text not null,
    payload text not null default '{}',
    status text not null default 'pending' check (status in ('pending','approved','rejected')),
    created_at text not null default ${NOW},
    decided_at text
  );
  create index approvals_status on approvals(status, created_at);

  -- seq is an explicit integer key so FTS rowids survive VACUUM
  create table memories (
    seq integer primary key autoincrement,
    id text not null unique,
    scope text not null check (scope in ('global','project')),
    project_id text references projects(id) on delete cascade,
    kind text not null default 'note' check (kind in ('preference','convention','fact','lesson','note')),
    content text not null,
    tags text not null default '[]',
    source_task_id text references tasks(id) on delete set null,
    created_at text not null default ${NOW},
    updated_at text not null default ${NOW},
    check ((scope = 'global' and project_id is null) or (scope = 'project' and project_id is not null))
  );
  create index memories_project on memories(project_id);

  create virtual table memories_fts using fts5(
    content, tags, content='memories', content_rowid='seq', tokenize='unicode61'
  );
  create trigger memories_ai after insert on memories begin
    insert into memories_fts(rowid, content, tags) values (new.seq, new.content, new.tags);
  end;
  create trigger memories_ad after delete on memories begin
    insert into memories_fts(memories_fts, rowid, content, tags) values ('delete', old.seq, old.content, old.tags);
  end;
  create trigger memories_au after update on memories begin
    insert into memories_fts(memories_fts, rowid, content, tags) values ('delete', old.seq, old.content, old.tags);
    insert into memories_fts(rowid, content, tags) values (new.seq, new.content, new.tags);
  end;

  create table role_settings (
    role text primary key check (role in ('planner','coder','reviewer','git','memory')),
    provider text not null,
    model text not null,
    reasoning_effort text,
    updated_at text not null default ${NOW}
  );
  insert into role_settings (role, provider, model) values
    ('planner',  'cheaperinference', 'deepseek-v4-flash'),
    ('coder',    'cheaperinference', 'deepseek-v4-flash'),
    ('reviewer', 'cheaperinference', 'deepseek-v4-flash'),
    ('git',      'cheaperinference', 'deepseek-v4-flash'),
    ('memory',   'cheaperinference', 'deepseek-v4-flash');
  `,
  `
  alter table projects add column setup_cmd text;
  alter table projects add column task_budget_usd real;
  alter table tasks add column worktree_path text;
  alter table agent_runs add column input_tokens integer not null default 0;
  alter table agent_runs add column output_tokens integer not null default 0;
  alter table agent_runs add column cache_read_tokens integer not null default 0;
  alter table agent_runs add column cost_usd real not null default 0;
  `,
  // The critic role: CHECK constraints cannot be altered in SQLite, so both tables are rebuilt.
  `
  create table role_settings_new (
    role text primary key check (role in ('planner','coder','reviewer','critic','git','memory')),
    provider text not null,
    model text not null,
    reasoning_effort text,
    updated_at text not null default ${NOW}
  );
  insert into role_settings_new (role, provider, model, reasoning_effort, updated_at)
    select role, provider, model, reasoning_effort, updated_at from role_settings;
  insert into role_settings_new (role, provider, model) values ('critic', 'cheaperinference', 'deepseek-v4-flash');
  drop table role_settings;
  alter table role_settings_new rename to role_settings;

  create table agent_runs_new (
    id text primary key,
    task_id text not null references tasks(id) on delete cascade,
    role text not null check (role in ('planner','coder','reviewer','critic','git','memory')),
    purpose text,
    provider text,
    model text,
    dsh_session_id text,
    status text not null default 'running' check (status in ('running','succeeded','failed','cancelled')),
    started_at text not null default ${NOW},
    ended_at text,
    input_tokens integer not null default 0,
    output_tokens integer not null default 0,
    cache_read_tokens integer not null default 0,
    cost_usd real not null default 0
  );
  insert into agent_runs_new (id, task_id, role, provider, model, dsh_session_id, status, started_at, ended_at,
    input_tokens, output_tokens, cache_read_tokens, cost_usd)
    select id, task_id, role, provider, model, dsh_session_id, status, started_at, ended_at,
    input_tokens, output_tokens, cache_read_tokens, cost_usd from agent_runs;
  drop table agent_runs;
  alter table agent_runs_new rename to agent_runs;
  create index agent_runs_task on agent_runs(task_id);

  alter table projects add column disabled_critics text not null default '[]';
  `,
  // Goals the project manager splits into epics and tasks; approvals can belong to a goal or an epic instead of a task.
  `
  create table goals (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    session_id text not null references sessions(id) on delete cascade,
    prompt text not null,
    status text not null default 'planning' check (status in (
      'planning','awaiting_approval','running','paused','done','cancelled','failed')),
    summary text,
    budget_usd real,
    error text,
    created_at text not null default ${NOW},
    updated_at text not null default ${NOW}
  );
  create index goals_session on goals(session_id, created_at);

  create table epics (
    id text primary key,
    goal_id text not null references goals(id) on delete cascade,
    position integer not null,
    title text not null,
    description text not null default '',
    status text not null default 'pending' check (status in (
      'pending','planning','running','awaiting_approval','pushing','done','paused','cancelled')),
    branch text,
    base_branch text,
    planned_tasks text not null default '[]',
    pr_url text,
    error text,
    created_at text not null default ${NOW},
    updated_at text not null default ${NOW},
    unique (goal_id, position)
  );

  alter table tasks add column kind text not null default 'code';
  alter table tasks add column goal_id text references goals(id) on delete set null;
  alter table tasks add column epic_id text references epics(id) on delete set null;
  alter table tasks add column epic_position integer;
  create index tasks_epic on tasks(epic_id, epic_position);

  create table approvals_new (
    id text primary key,
    task_id text references tasks(id) on delete cascade,
    goal_id text references goals(id) on delete cascade,
    epic_id text references epics(id) on delete cascade,
    kind text not null check (kind in ('push_and_pr','permission','plan','epic_push')),
    summary text not null,
    payload text not null default '{}',
    status text not null default 'pending' check (status in ('pending','approved','rejected')),
    created_at text not null default ${NOW},
    decided_at text
  );
  insert into approvals_new (id, task_id, kind, summary, payload, status, created_at, decided_at)
    select id, task_id, kind, summary, payload, status, created_at, decided_at from approvals;
  drop table approvals;
  alter table approvals_new rename to approvals;
  create index approvals_status on approvals(status, created_at);
  `,
  // Server-wide settings (the daily budget, the stronger model) and quick "spent today" sums.
  `
  create table app_settings (
    key text primary key,
    value text not null,
    updated_at text not null default ${NOW}
  );
  create index agent_runs_started on agent_runs(started_at);
  `,
  // How to start a project's app for the visual check.
  `
  alter table projects add column start_cmd text;
  alter table projects add column app_url text;
  `,
  // Model providers set up on the Models page. Keys are stored encrypted by the server; the brain never sees them in
  // plain text. The stronger model and the screenshot model become provider + model pairs.
  `
  create table providers (
    id text primary key,
    name text not null,
    type text not null check (type in ('openai','anthropic','gemini')),
    base_url text not null,
    key_cipher text,
    key_last4 text,
    created_at text not null default ${NOW},
    updated_at text not null default ${NOW}
  );
  insert into providers (id, name, type, base_url) values ('cheaperinference', 'CheaperInference', 'openai', 'https://api.cheaperinference.com/v1');

  create table model_prices (
    provider_id text not null references providers(id) on delete cascade,
    model text not null,
    input_per_million real not null,
    output_per_million real not null,
    cache_read_per_million real,
    updated_at text not null default ${NOW},
    primary key (provider_id, model)
  );

  update app_settings set value = json_object('provider', 'cheaperinference', 'model', json_extract(value, '$'))
    where key in ('escalationModel', 'visionModel') and json_type(value) = 'text';
  `,
];

/** Applies pending migrations; `target` stops early (tests use it to build an old database). */
export function migrate(db: DatabaseSync, target = MIGRATIONS.length): void {
  const { user_version } = db.prepare("pragma user_version").get() as { user_version: number };
  if (user_version >= target) return;
  // Rebuilding a table must not fire ON DELETE actions (events.run_id would be cleared). SQLite ignores this pragma
  // inside a transaction, so it is switched off around the migrations and every result is checked instead.
  db.exec("pragma foreign_keys = off");
  try {
    for (let version = user_version; version < target; version++) {
      db.exec("begin immediate");
      try {
        db.exec(MIGRATIONS[version]!);
        const broken = db.prepare("pragma foreign_key_check").all();
        if (broken.length) throw new Error(`Migration ${version + 1} would leave ${broken.length} broken references`);
        db.exec(`pragma user_version = ${version + 1}`);
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    }
  } finally {
    db.exec("pragma foreign_keys = on");
  }
}
