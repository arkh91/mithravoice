-- mithravoice database schema (MySQL 8.0+)
--
-- Run directly on your existing MySQL server:
--   mysql -u root -p < schema.sql
--
-- Requires MySQL 8.0.13+ for `DEFAULT (UUID())` expression defaults and
-- 8.0.16+ for enforced CHECK constraints (this schema uses ENUM instead
-- of CHECK for status columns, so it's compatible further back too).
-- If your server predates 8.0.13, drop the `DEFAULT (UUID())` clauses —
-- the app layer (SQLAlchemy, see app/models.py) always supplies a UUID
-- on insert regardless, so the column default is a safety net, not a
-- requirement.
--
-- Model:
--   users          — a customer (one email, may hold several subscriptions over time)
--   plans          — sellable tiers (Solo, Team, etc.) defining seat count + feature flags,
--                    including how many online-engine hours are bundled per period
--   subscriptions  — a user's purchase of a plan for a billing period
--   license_keys   — the actual key string a user types into the app; belongs to one subscription
--   devices        — machines a key has been activated on, capped by plan.max_devices
--   activation_events — audit trail of every activate/heartbeat/deactivate call
--   usage_sessions — optional analytics: how long, which engine (online/offline), per device
--   app_versions   — published release metadata used for update checks
--   online_usage_periods — rolling per-key online-engine quota tracking (one row per
--                    billing period per key), used to enforce plans.online_hours_included
--   telegram_accounts — Telegram bot end users (support/notifications bot), keyed by
--                    the numeric Telegram user id; independent of the users table above
--   telegram_admins   — staff allowed to operate the Telegram bot's admin commands

CREATE DATABASE IF NOT EXISTS mithravoice
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE mithravoice;

CREATE TABLE users (
    id          CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    email       VARCHAR(255) NOT NULL,
    full_name   VARCHAR(255),
    is_active   TINYINT(1)   NOT NULL DEFAULT 1,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE plans (
    id                     CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    code                   VARCHAR(64)  NOT NULL,                 -- e.g. 'solo_monthly', 'team_annual'
    name                   VARCHAR(100) NOT NULL,                 -- e.g. 'Solo'
    max_devices            INT          NOT NULL DEFAULT 1,
    online_allowed         TINYINT(1)   NOT NULL DEFAULT 1,        -- can use the Azure engine
    offline_allowed        TINYINT(1)   NOT NULL DEFAULT 1,        -- can use the Whisper+Argos engine
    price_cents            INT          NOT NULL DEFAULT 0,
    billing_interval       ENUM('monthly','annual','lifetime') NOT NULL DEFAULT 'monthly',
    created_at             TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    online_hours_included  INT UNSIGNED,                          -- online-engine quota per billing
                                                                    -- period; NULL = unmetered/unlimited
    UNIQUE KEY uq_plans_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE subscriptions (
    id                    CHAR(36)  NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    user_id               CHAR(36)  NOT NULL,
    plan_id               CHAR(36)  NOT NULL,
    status                ENUM('active','canceled','past_due','expired') NOT NULL DEFAULT 'active',
    current_period_start  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    current_period_end    TIMESTAMP NOT NULL,
    created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_subscriptions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES plans(id),
    KEY idx_subscriptions_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE license_keys (
    id                CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    subscription_id   CHAR(36)     NOT NULL,
    key_code          VARCHAR(32)  NOT NULL,        -- e.g. 'MVCE-7F3A-9K2Q-XPL4'
    status            ENUM('active','revoked','expired') NOT NULL DEFAULT 'active',
    issued_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at        TIMESTAMP    NOT NULL,
    CONSTRAINT fk_license_keys_subscription FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
    UNIQUE KEY uq_license_keys_key_code (key_code),
    KEY idx_license_keys_subscription (subscription_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE devices (
    id                CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    license_key_id    CHAR(36)     NOT NULL,
    fingerprint       VARCHAR(64)  NOT NULL,         -- stable per-machine hash generated by the client
    hostname          VARCHAR(255),
    os                VARCHAR(255),
    is_active         TINYINT(1)   NOT NULL DEFAULT 1,
    first_seen_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_devices_license_key FOREIGN KEY (license_key_id) REFERENCES license_keys(id) ON DELETE CASCADE,
    UNIQUE KEY uq_devices_key_fingerprint (license_key_id, fingerprint),
    KEY idx_devices_license_key (license_key_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE activation_events (
    id                CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    license_key_id    CHAR(36)     NULL,
    device_id         CHAR(36)     NULL,
    event_type        ENUM('activate','heartbeat','deactivate','denied') NOT NULL,
    detail            TEXT,                          -- e.g. denial reason
    ip_address        VARCHAR(45),                    -- long enough for IPv6
    created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_activation_events_license_key FOREIGN KEY (license_key_id) REFERENCES license_keys(id) ON DELETE SET NULL,
    CONSTRAINT fk_activation_events_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
    KEY idx_activation_events_key (license_key_id),
    KEY idx_activation_events_device (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE usage_sessions (
    id                CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    license_key_id    CHAR(36)     NOT NULL,
    device_id         CHAR(36)     NOT NULL,
    engine_used       ENUM('online','offline') NOT NULL,
    started_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at          TIMESTAMP    NULL,
    duration_seconds  INT,
    CONSTRAINT fk_usage_sessions_license_key FOREIGN KEY (license_key_id) REFERENCES license_keys(id) ON DELETE CASCADE,
    CONSTRAINT fk_usage_sessions_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    KEY idx_usage_sessions_key (license_key_id),
    KEY idx_usage_sessions_device (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tracks published app releases so the client can check "is a newer
-- version available" on launch (GET /v1/latest-version reads whichever
-- row has is_latest=1). Populated via server/publish_version.py, not
-- hand-edited — that script also unmarks the previous latest row so
-- exactly one is ever flagged current.
CREATE TABLE app_versions (
    id             CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    version        VARCHAR(20)  NOT NULL,          -- e.g. '2.0.1', matches the VERSION file used at build time
    is_latest      TINYINT(1)   NOT NULL DEFAULT 0,
    download_url   VARCHAR(500) NOT NULL,          -- e.g. https://mithracorp.com/mithravoice/versions.html
    release_notes  TEXT,
    released_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_app_versions_version (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per license key per billing period, used to meter the online
-- (Azure) engine against plans.online_hours_included. Usage: on every
-- online usage_session close, the app adds duration_seconds to the row
-- for that key_code + current period (creating it if absent), and stamps
-- exceeded_at the first time seconds_used passes seconds_included, which
-- the API then uses to deny further online activity until the period rolls.
-- Keyed by key_code (not license_key_id) so it survives a key being
-- reissued/rotated on the same subscription without losing usage history.
CREATE TABLE online_usage_periods (
    id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    key_code           VARCHAR(32)  NOT NULL,
    period_start       DATE         NOT NULL,
    period_end         DATE         NOT NULL,
    seconds_used       INT UNSIGNED NOT NULL DEFAULT 0,
    seconds_included   INT UNSIGNED NOT NULL,           -- snapshot of plan.online_hours_included*3600
                                                          -- at period creation, so later plan changes
                                                          -- don't retroactively alter past periods
    exceeded_at        TIMESTAMP    NULL,
    updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_online_usage_periods_key_code FOREIGN KEY (key_code) REFERENCES license_keys(key_code) ON DELETE CASCADE,
    UNIQUE KEY uq_online_usage_periods_key_period (key_code, period_start, period_end),
    KEY idx_online_usage_periods_key_code (key_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Telegram support/notifications bot subsystem. Deliberately independent
-- of the `users` table above — UserID here is Telegram's own numeric
-- account id, populated the first time someone messages the bot, not a
-- customer signup. CurrentBalance is used for bot-side credit/payment
-- features unrelated to the subscription billing model.
CREATE TABLE telegram_accounts (
    UserID           INT            NOT NULL PRIMARY KEY,       -- Telegram user id (from the Bot API), not app-generated
    FirstName        VARCHAR(50),
    LastName         VARCHAR(50),
    Username         VARCHAR(50),
    CurrentBalance   DECIMAL(10,2) DEFAULT 0.00,
    CreatedAt        DATETIME      DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Staff permitted to run privileged commands in the Telegram bot.
-- UserID is unique (one admin row per Telegram account); Role gates
-- which bot commands are available (moderator < admin < superadmin).
CREATE TABLE telegram_admins (
    AdminID    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    UserID     BIGINT UNSIGNED NOT NULL,
    Username   VARCHAR(255),
    Role       ENUM('superadmin','admin','moderator') DEFAULT 'admin',
    AddedAt    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    IsActive   TINYINT(1) DEFAULT 1,
    UNIQUE KEY uq_telegram_admins_userid (UserID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Test plan with a tight 1-hour online quota, for exercising the
-- online_usage_periods exceeded_at path without waiting on real usage.
INSERT INTO plans (code, name, max_devices, online_allowed, offline_allowed, price_cents, billing_interval, online_hours_included)
VALUES
    ('test', 'Test (1hr online)', 1, 1, 1, 0, 'monthly', 1);
