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
