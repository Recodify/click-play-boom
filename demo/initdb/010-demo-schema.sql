CREATE DATABASE IF NOT EXISTS click_play_boom_demo;

CREATE TABLE IF NOT EXISTS click_play_boom_demo.service_catalog
(
    service LowCardinality(String),
    display_name String,
    owner LowCardinality(String),
    tier UInt8,
    monthly_slo Decimal(5, 3),
    repository String,
    updated_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY service;

CREATE TABLE IF NOT EXISTS click_play_boom_demo.requests
(
    request_id UInt64,
    observed_at DateTime64(3),
    service LowCardinality(String),
    region LowCardinality(String),
    endpoint LowCardinality(String),
    status_code UInt16,
    latency_ms Float64,
    response_bytes UInt64,
    trace_id UUID
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(observed_at)
ORDER BY (service, observed_at, request_id)
TTL toDateTime(observed_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS click_play_boom_demo.request_rollup_5m
(
    bucket DateTime,
    service LowCardinality(String),
    region LowCardinality(String),
    requests UInt64,
    errors UInt64,
    latency_ms Float64,
    response_bytes UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (service, region, bucket);

CREATE MATERIALIZED VIEW IF NOT EXISTS click_play_boom_demo.requests_to_rollup_5m
TO click_play_boom_demo.request_rollup_5m
AS
SELECT
    toStartOfFiveMinutes(observed_at) AS bucket,
    service,
    region,
    count() AS requests,
    countIf(status_code >= 500) AS errors,
    sum(latency_ms) AS latency_ms,
    sum(response_bytes) AS response_bytes
FROM click_play_boom_demo.requests
GROUP BY bucket, service, region;

CREATE TABLE IF NOT EXISTS click_play_boom_demo.deployments
(
    deployed_at DateTime64(3),
    service LowCardinality(String),
    version String,
    environment LowCardinality(String),
    duration_seconds UInt32,
    outcome Enum8('succeeded' = 1, 'rolled_back' = 2, 'failed' = 3)
)
ENGINE = MergeTree
ORDER BY (service, deployed_at);

CREATE TABLE IF NOT EXISTS click_play_boom_demo.schema_mv_targets
(
    database LowCardinality(String),
    name String,
    target_database LowCardinality(String),
    target_table String,
    updated_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (database, name);

CREATE VIEW IF NOT EXISTS click_play_boom_demo.service_health AS
SELECT
    metrics.bucket,
    metrics.service,
    any(catalog.display_name) AS display_name,
    any(catalog.owner) AS owner,
    metrics.region,
    sum(metrics.requests) AS requests,
    sum(metrics.errors) AS errors,
    round(100 * errors / requests, 2) AS error_rate,
    round(sum(metrics.latency_ms) / requests, 1) AS avg_latency_ms,
    formatReadableSize(sum(metrics.response_bytes)) AS response_volume
FROM click_play_boom_demo.request_rollup_5m AS metrics
LEFT JOIN click_play_boom_demo.service_catalog AS catalog USING (service)
GROUP BY metrics.bucket, metrics.service, metrics.region;

CREATE DICTIONARY IF NOT EXISTS click_play_boom_demo.service_owners
(
    service String,
    owner String,
    tier UInt8,
    monthly_slo Decimal(5, 3)
)
PRIMARY KEY service
SOURCE(CLICKHOUSE(
    HOST 'localhost'
    PORT 9000
    USER 'demo'
    PASSWORD 'clickplayboom'
    DB 'click_play_boom_demo'
    TABLE 'service_catalog'
))
LIFETIME(MIN 0 MAX 0)
LAYOUT(HASHED());
