-- schema.sql
-- Run this script in your MySQL database to set up the Leave Management tables.

-- 1. Leave Applications Table
CREATE TABLE IF NOT EXISTS `wp_hrms_leaves` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `employee_id` BIGINT UNSIGNED NOT NULL,
  `leave_type` VARCHAR(50) NOT NULL,
  `start_date` DATE NOT NULL,
  `end_date` DATE NOT NULL,
  `leave_days` DECIMAL(5,2) NOT NULL,
  `cl_days_charged` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  `extra_lwp_days` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  `reason` TEXT NOT NULL,
  `day_type` ENUM('full_day', 'half_day') NOT NULL DEFAULT 'full_day',
  `half_day_period` ENUM('first_half', 'second_half') DEFAULT NULL,
  
  -- Level 1: Leader Approval
  `leader_id` BIGINT UNSIGNED DEFAULT NULL,
  `leader_status` ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
  `leader_approved_at` DATETIME DEFAULT NULL,
  `leader_rejection_reason` TEXT DEFAULT NULL,
  
  -- Level 2: HR Approval
  `hr_id` BIGINT UNSIGNED DEFAULT NULL,
  `hr_status` ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
  `hr_approved_at` DATETIME DEFAULT NULL,
  `hr_rejection_reason` TEXT DEFAULT NULL,
  
  -- Overall Status
  `status` ENUM('pending', 'approved', 'rejected', 'partially_approved') DEFAULT 'pending',
  
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  -- Foreign key references to WordPress users table
  FOREIGN KEY (`employee_id`) REFERENCES `wp_users`(`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Leave Balances Table
CREATE TABLE IF NOT EXISTS `wp_hrms_leave_balances` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `employee_id` BIGINT UNSIGNED NOT NULL,
  `year` INT NOT NULL,
  `balance_json` JSON NOT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `idx_emp_year` (`employee_id`, `year`),
  FOREIGN KEY (`employee_id`) REFERENCES `wp_users`(`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
