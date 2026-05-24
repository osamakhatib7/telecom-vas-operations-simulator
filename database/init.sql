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

INSERT INTO balances (msisdn, balance) VALUES
  ('0599123456', 10.50),
  ('970599123456', 10.50),
  ('0599000000', 0.00)
ON DUPLICATE KEY UPDATE balance = VALUES(balance);
