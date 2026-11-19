INSERT INTO click_play_boom_demo.service_catalog
    (service, display_name, owner, tier, monthly_slo, repository, updated_at)
VALUES
    ('checkout', 'Checkout API', 'Revenue Platform', 1, 99.950, 'github.com/acme/checkout', now64(3)),
    ('catalog', 'Product Catalog', 'Shopping Experience', 1, 99.900, 'github.com/acme/catalog', now64(3)),
    ('identity', 'Identity Gateway', 'Core Platform', 1, 99.990, 'github.com/acme/identity', now64(3)),
    ('recommendations', 'Recommendations', 'Data Products', 2, 99.500, 'github.com/acme/recommendations', now64(3));

INSERT INTO click_play_boom_demo.requests
SELECT
    number + 1 AS request_id,
    now64(3) - toIntervalMinute(intDiv(number, 4)) AS observed_at,
    arrayElement(['checkout', 'catalog', 'identity', 'recommendations'], toUInt32(number % 4) + 1) AS service,
    arrayElement(['eu-west-1', 'us-east-1', 'ap-southeast-2'], toUInt32(intDiv(number, 4) % 3) + 1) AS region,
    arrayElement(['/v1/search', '/v1/items', '/v1/session', '/v1/orders', '/health'], toUInt32(number % 5) + 1) AS endpoint,
    multiIf(number % 97 = 0, 503, number % 53 = 0, 500, number % 29 = 0, 429, 200) AS status_code,
    round(12 + (number % 160) * 0.85 + if(service = 'recommendations', 42, 0) + if(status_code >= 500, 180, 0), 2) AS latency_ms,
    640 + (number * 7919) % 65000 AS response_bytes,
    reinterpretAsUUID(unhex(lower(hex(sipHash128(number))))) AS trace_id
FROM numbers(80640);

INSERT INTO click_play_boom_demo.deployments
SELECT
    now64(3) - toIntervalHour(number * 7) AS deployed_at,
    arrayElement(['checkout', 'catalog', 'identity', 'recommendations'], toUInt32(number % 4) + 1) AS service,
    concat('2026.', toString(1 + intDiv(number, 24)), '.', toString(number % 24)) AS version,
    if(number % 5 = 0, 'staging', 'production') AS environment,
    toUInt32(35 + (number * 17) % 420) AS duration_seconds,
    multiIf(number % 41 = 0, 'failed', number % 23 = 0, 'rolled_back', 'succeeded') AS outcome
FROM numbers(240);

INSERT INTO click_play_boom_demo.schema_mv_targets
    (database, name, target_database, target_table, updated_at)
VALUES
    ('click_play_boom_demo', 'requests_to_rollup_5m', 'click_play_boom_demo', 'request_rollup_5m', now64(3));
