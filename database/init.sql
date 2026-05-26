CREATE TABLE IF NOT EXISTS balances (
  msisdn VARCHAR(20) PRIMARY KEY,
  balance DECIMAL(10, 2) NOT NULL
);

CREATE TABLE IF NOT EXISTS ocs_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  msisdn VARCHAR(20) NOT NULL,
  transaction_type VARCHAR(50) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  status VARCHAR(50) NOT NULL,
  balance_after DECIMAL(10, 2),
  reference_id VARCHAR(100),
  details JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bundle_offers (
  offer_code VARCHAR(50) PRIMARY KEY,
  bundle_name VARCHAR(100) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  data_allowance_mb INT NOT NULL,
  validity_days INT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS active_bundles (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  msisdn VARCHAR(20) NOT NULL,
  offer_code VARCHAR(50) NOT NULL,
  bundle_name VARCHAR(100) NOT NULL,
  remaining_data_mb INT NOT NULL,
  valid_from DATETIME NOT NULL,
  valid_until DATETIME NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  activation_reference_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_active_bundles_msisdn_status (msisdn, status),
  INDEX idx_active_bundles_validity (valid_until)
);

CREATE TABLE IF NOT EXISTS refunds (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  msisdn VARCHAR(20) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  original_reference_id VARCHAR(100),
  refund_reference_id VARCHAR(100) NOT NULL UNIQUE,
  status VARCHAR(50) NOT NULL,
  reason VARCHAR(255),
  balance_after DECIMAL(10, 2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_refunds_msisdn (msisdn),
  INDEX idx_refunds_original_reference (original_reference_id)
);

CREATE TABLE IF NOT EXISTS subscribers (
  msisdn VARCHAR(20) PRIMARY KEY,
  status VARCHAR(20) NOT NULL,
  subscriber_type VARCHAR(20) NOT NULL,
  segment VARCHAR(50) NOT NULL,
  campaign_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscriber_allowed_services (
  msisdn VARCHAR(20) NOT NULL,
  service_code VARCHAR(50) NOT NULL,
  PRIMARY KEY (msisdn, service_code),
  CONSTRAINT fk_allowed_services_subscriber
    FOREIGN KEY (msisdn) REFERENCES subscribers(msisdn)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS content_offers (
  category VARCHAR(50) PRIMARY KEY,
  offer_name VARCHAR(100) NOT NULL,
  provider_code VARCHAR(50) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  validity_days INT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS content_subscriptions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  msisdn VARCHAR(20) NOT NULL,
  category VARCHAR(50) NOT NULL,
  offer_name VARCHAR(100) NOT NULL,
  provider_code VARCHAR(50) NOT NULL,
  provider_reference VARCHAR(100) NOT NULL,
  reference_id VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  valid_from DATETIME NOT NULL,
  valid_until DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_content_subscriptions_msisdn_category_status (msisdn, category, status),
  INDEX idx_content_subscriptions_validity (valid_until)
);

CREATE TABLE IF NOT EXISTS sms_attempts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  msisdn VARCHAR(20),
  message TEXT,
  delivery_status VARCHAR(50) NOT NULL,
  error_message VARCHAR(255),
  reference_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sms_attempts_msisdn_created_at (msisdn, created_at)
);

CREATE TABLE IF NOT EXISTS gateway_transactions (
  transaction_id VARCHAR(50) PRIMARY KEY,
  correlation_id VARCHAR(100),
  session_id VARCHAR(100),
  msisdn VARCHAR(20),
  protocol VARCHAR(50),
  event_type VARCHAR(50),
  service_type VARCHAR(50),
  service_code VARCHAR(50),
  ussd_code VARCHAR(50),
  input_text TEXT,
  destination_platform VARCHAR(100),
  status VARCHAR(50) NOT NULL,
  failure_reason VARCHAR(100),
  error_message TEXT,
  response_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_gateway_transactions_created_at (created_at),
  INDEX idx_gateway_transactions_correlation_id (correlation_id),
  INDEX idx_gateway_transactions_msisdn (msisdn),
  INDEX idx_gateway_transactions_filters (service_type, service_code, status, failure_reason)
);

CREATE TABLE IF NOT EXISTS vas_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  correlation_id VARCHAR(100),
  session_id VARCHAR(100),
  msisdn VARCHAR(20),
  ussd_code VARCHAR(50),
  input_text TEXT,
  selected_option VARCHAR(20),
  flow_name VARCHAR(100),
  subscriber_status VARCHAR(50),
  status VARCHAR(50) NOT NULL DEFAULT 'IN_PROGRESS',
  failure_reason VARCHAR(100),
  customer_message TEXT,
  crm_checked BOOLEAN NOT NULL DEFAULT FALSE,
  ocs_checked BOOLEAN NOT NULL DEFAULT FALSE,
  aggregator_checked BOOLEAN NOT NULL DEFAULT FALSE,
  smsc_checked BOOLEAN NOT NULL DEFAULT FALSE,
  charge_reference_id VARCHAR(100),
  refund_reference_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_vas_transactions_created_at (created_at),
  INDEX idx_vas_transactions_correlation_id (correlation_id),
  INDEX idx_vas_transactions_session_id (session_id),
  INDEX idx_vas_transactions_msisdn (msisdn),
  INDEX idx_vas_transactions_status_flow (status, flow_name)
);

INSERT INTO balances (msisdn, balance) VALUES
  ('0599123456', 10.50),
  ('970599123456', 10.50),
  ('0599000000', 0.00)
ON DUPLICATE KEY UPDATE balance = VALUES(balance);

INSERT INTO bundle_offers
  (offer_code, bundle_name, price, data_allowance_mb, validity_days, is_active)
VALUES
  ('BUNDLE_1GB', '1GB Internet Bundle', 5.00, 1024, 7, TRUE)
ON DUPLICATE KEY UPDATE
  bundle_name = VALUES(bundle_name),
  price = VALUES(price),
  data_allowance_mb = VALUES(data_allowance_mb),
  validity_days = VALUES(validity_days),
  is_active = VALUES(is_active);

INSERT INTO subscribers
  (msisdn, status, subscriber_type, segment, campaign_eligible)
VALUES
  ('0599123456', 'ACTIVE', 'PREPAID', 'MASS_MARKET', TRUE),
  ('970599123456', 'ACTIVE', 'PREPAID', 'MASS_MARKET', TRUE),
  ('0599000000', 'SUSPENDED', 'PREPAID', 'MASS_MARKET', FALSE)
ON DUPLICATE KEY UPDATE
  status = VALUES(status),
  subscriber_type = VALUES(subscriber_type),
  segment = VALUES(segment),
  campaign_eligible = VALUES(campaign_eligible);

INSERT INTO subscriber_allowed_services (msisdn, service_code) VALUES
  ('0599123456', '*123#'),
  ('0599123456', 'INTERNET_BUNDLE'),
  ('0599123456', 'GENERAL_NEWS'),
  ('970599123456', '*123#'),
  ('970599123456', 'INTERNET_BUNDLE'),
  ('970599123456', 'GENERAL_NEWS'),
  ('0599000000', '*123#')
ON DUPLICATE KEY UPDATE service_code = VALUES(service_code);

INSERT INTO content_offers
  (category, offer_name, provider_code, price, validity_days, is_active)
VALUES
  ('GENERAL_NEWS', 'General News Alerts', 'NEWS_GENERAL', 1.00, 30, TRUE)
ON DUPLICATE KEY UPDATE
  offer_name = VALUES(offer_name),
  provider_code = VALUES(provider_code),
  price = VALUES(price),
  validity_days = VALUES(validity_days),
  is_active = VALUES(is_active);
