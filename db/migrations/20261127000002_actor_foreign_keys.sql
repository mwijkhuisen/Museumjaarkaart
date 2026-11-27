-- migrate:up
-- P2a: the plain-uuid actor columns P1a left for app_user (see 20261102000002_museums.sql). Expand-only: the
-- previous image writes NULL there, so the keys are added NOT VALID and validated at once.
ALTER TABLE museum_change ADD CONSTRAINT museum_change_reporter_id_fkey
  FOREIGN KEY (reporter_id) REFERENCES app_user (id) ON DELETE SET NULL NOT VALID;
ALTER TABLE museum_change ADD CONSTRAINT museum_change_decided_by_fkey
  FOREIGN KEY (decided_by) REFERENCES app_user (id) ON DELETE SET NULL NOT VALID;
ALTER TABLE mk_list_version ADD CONSTRAINT mk_list_version_published_by_fkey
  FOREIGN KEY (published_by) REFERENCES app_user (id) ON DELETE SET NULL NOT VALID;

ALTER TABLE museum_change VALIDATE CONSTRAINT museum_change_reporter_id_fkey;
ALTER TABLE museum_change VALIDATE CONSTRAINT museum_change_decided_by_fkey;
ALTER TABLE mk_list_version VALIDATE CONSTRAINT mk_list_version_published_by_fkey;

-- migrate:down
ALTER TABLE mk_list_version DROP CONSTRAINT mk_list_version_published_by_fkey;
ALTER TABLE museum_change DROP CONSTRAINT museum_change_decided_by_fkey;
ALTER TABLE museum_change DROP CONSTRAINT museum_change_reporter_id_fkey;
