-- migrate:up
-- P1a (A§8, plan §2.5): the job queue. `kind` and `last_error` are fixed codes, so an
-- error message (which could quote user data) can never be stored here.
CREATE TABLE job (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{1,40}$'),
  payload jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  locked_at timestamptz,
  locked_by text CHECK (char_length(locked_by) <= 100),
  last_error text CHECK (last_error ~ '^[a-z_]{1,40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX job_queued_idx ON job (run_at, id) WHERE state = 'queued';
CREATE INDEX job_running_idx ON job (locked_at) WHERE state = 'running';

-- The worker claims and finishes jobs; the api (the admin CLI) only enqueues. No DELETE for anyone.
GRANT SELECT, INSERT, UPDATE ON job TO mjk_worker;
GRANT SELECT, INSERT ON job TO mjk_api;

-- migrate:down
DROP TABLE job;
