-- auth_events has no actor column; activity view must not reference ae.actor
DROP VIEW IF EXISTS activity;
CREATE VIEW activity AS
  SELECT
    'post_version' AS kind,
    pv.created_at,
    pv.post_id,
    NULL AS brand_id,
    pv.actor_kind,
    pv.actor_name,
    pv.actor_client,
    json_object(
      'post_id', pv.post_id,
      'version', pv.version
    ) AS detail_json
  FROM post_versions pv

  UNION ALL

  SELECT
    'approval' AS kind,
    a.created_at,
    a.post_id,
    NULL AS brand_id,
    a.actor_kind,
    a.actor_name,
    a.actor_client,
    json_object(
      'post_id', a.post_id,
      'stage',   a.stage,
      'decision', a.decision,
      'comment', a.comment
    ) AS detail_json
  FROM approvals a

  UNION ALL

  SELECT
    'iteration' AS kind,
    i.created_at,
    i.post_id,
    NULL AS brand_id,
    'human' AS actor_kind,
    i.author AS actor_name,
    NULL AS actor_client,
    json_object(
      'post_id', i.post_id,
      'comment', i.comment,
      'target',  i.target
    ) AS detail_json
  FROM iterations i

  UNION ALL

  SELECT
    'run' AS kind,
    r.started_at AS created_at,
    r.post_id,
    NULL AS brand_id,
    r.actor_kind,
    r.actor_name,
    r.actor_client,
    json_object(
      'run_id',  r.id,
      'kind',    r.kind,
      'status',  r.status,
      'post_id', r.post_id
    ) AS detail_json
  FROM runs r

  UNION ALL

  SELECT
    'auth' AS kind,
    ae.created_at,
    NULL AS post_id,
    NULL AS brand_id,
    'human' AS actor_kind,
    NULL AS actor_name,
    NULL AS actor_client,
    json_object('event', ae.event, 'detail', ae.detail) AS detail_json
  FROM auth_events ae;
