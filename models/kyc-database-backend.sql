-- =============================================================================
-- COMPREHENSIVE KYC DATABASE SCHEMA FOR NIGERIAN FINTECH
-- =============================================================================

-- Users table (main user information)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    phone_number VARCHAR(20) UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- KYC Applications table (main KYC record)
CREATE TABLE kyc_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- Status and Progress
    overall_status VARCHAR(20) DEFAULT 'pending' CHECK (overall_status IN ('pending', 'in_progress', 'approved', 'rejected', 'suspended', 'expired')),
    kyc_tier VARCHAR(10) DEFAULT 'tier_1' CHECK (kyc_tier IN ('tier_1', 'tier_2', 'tier_3')),
    completion_percentage INTEGER DEFAULT 0 CHECK (completion_percentage >= 0 AND completion_percentage <= 100),
    
    -- Risk Assessment
    risk_level VARCHAR(10) DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
    risk_score DECIMAL(5,2) DEFAULT 0.00,
    
    -- Compliance Flags
    is_pep BOOLEAN DEFAULT FALSE,
    sanctions_hit BOOLEAN DEFAULT FALSE,
    adverse_media_hit BOOLEAN DEFAULT FALSE,
    
    -- Application Metadata
    application_reference VARCHAR(50) UNIQUE NOT NULL,
    submitted_at TIMESTAMP WITH TIME ZONE,
    approved_at TIMESTAMP WITH TIME ZONE,
    rejected_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    
    -- Officer Assignment
    assigned_officer_id UUID,
    review_started_at TIMESTAMP WITH TIME ZONE,
    review_completed_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Personal Information
CREATE TABLE kyc_personal_info (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kyc_application_id UUID NOT NULL REFERENCES kyc_applications(id) ON DELETE CASCADE,
    
    -- Basic Info
    first_name VARCHAR(100) NOT NULL,
    middle_name VARCHAR(100),
    last_name VARCHAR(100) NOT NULL,
    date_of_birth DATE NOT NULL,
    gender VARCHAR(10) CHECK (gender IN ('male', 'female', 'other')),
    
    -- Nationality and Location
    nationality VARCHAR(50) DEFAULT 'Nigerian',
    country_of_birth VARCHAR(50),
    state_of_origin VARCHAR(50),
    local_government_area VARCHAR(100),
    
    -- Personal Details
    marital_status VARCHAR(20) CHECK (marital_status IN ('single', 'married', 'divorced', 'widowed')),
    occupation VARCHAR(100),
    employer_name VARCHAR(200),
    employer_address TEXT,
    monthly_income DECIMAL(15,2),
    source_of_funds VARCHAR(100),
    
    -- Address Information
    residential_address TEXT,
    residential_city VARCHAR(100),
    residential_state VARCHAR(50),
    residential_country VARCHAR(50) DEFAULT 'Nigeria',
    postal_code VARCHAR(20),
    
    -- Next of Kin
    nok_name VARCHAR(200),
    nok_relationship VARCHAR(50),
    nok_phone_number VARCHAR(20),
    nok_email VARCHAR(255),
    nok_address TEXT,
    
    -- Verification Status
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    verified_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Document Management
CREATE TABLE kyc_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kyc_application_id UUID NOT NULL REFERENCES kyc_applications(id) ON DELETE CASCADE,
    
    -- Document Classification
    document_type VARCHAR(50) NOT NULL,
    document_category VARCHAR(30) NOT NULL CHECK (document_category IN ('identity', 'address', 'financial', 'biometric')),
    is_required BOOLEAN DEFAULT TRUE,
    
    -- File Information
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    file_size INTEGER,
    file_type VARCHAR(50),
    file_hash VARCHAR(128),
    
    -- Document Details
    document_number VARCHAR(100),
    issue_date DATE,
    expiry_date DATE,
    issuing_authority VARCHAR(100),
    
    -- Processing Status
    status VARCHAR(20) DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'processing', 'approved', 'rejected')),
    rejection_reason TEXT,
    
    -- OCR and Analysis Results
    ocr_data JSONB,
    face_match_score DECIMAL(5,2),
    quality_score DECIMAL(5,2),
    
    -- Verification Details
    verified_by UUID,
    verified_at TIMESTAMP WITH TIME ZONE,
    
    -- Audit
    uploaded_by UUID NOT NULL REFERENCES users(id),
    ip_address INET,
    user_agent TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Government ID Verifications (NIN, BVN, etc.)
CREATE TABLE kyc_government_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kyc_application_id UUID NOT NULL REFERENCES kyc_applications(id) ON DELETE CASCADE,
    
    -- Verification Type
    verification_type VARCHAR(20) NOT NULL CHECK (verification_type IN ('nin', 'bvn', 'drivers_license', 'voters_card')),
    
    -- ID Details
    id_number VARCHAR(50) NOT NULL,
    masked_id_number VARCHAR(50),
    
    -- Verification Status
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'expired')),
    match_score DECIMAL(5,2),
    
    -- Verification Data
    verification_data JSONB,
    verification_response JSONB,
    
    -- Provider Information
    verification_provider VARCHAR(50),
    provider_reference VARCHAR(100),
    
    -- Verification Timestamps
    verified_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(kyc_application_id, verification_type, id_number)
);

-- Phone and Email Verifications
CREATE TABLE kyc_contact_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kyc_application_id UUID NOT NULL REFERENCES kyc_applications(id) ON DELETE CASCADE,
    
    -- Contact Type
    contact_type VARCHAR(10) NOT NULL CHECK (contact_type IN ('phone', 'email')),
    contact_value VARCHAR(255) NOT NULL,
    
    -- Verification Details
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'expired')),
    verification_code VARCHAR(10),
    verification_attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    
    -- Timestamps
    code_sent_at TIMESTAMP WITH TIME ZONE,
    verified_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Bank Account Verifications
CREATE TABLE kyc_bank_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kyc_application_id UUID NOT NULL REFERENCES kyc_applications(id) ON DELETE CASCADE,
    
    -- Bank Details
    bank_name VARCHAR(100) NOT NULL,
    bank_code VARCHAR(10),
    account_number VARCHAR(20) NOT NULL,
    account_name VARCHAR(200),
    account_type VARCHAR(20),
    
    -- Verification Status
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed')),
    match_score DECIMAL(5,2),
    name_match_score DECIMAL(5,2),
    
    -- Verification Data
    verification_response JSONB,
    
    -- Provider Information
    verification_provider VARCHAR(50),
    
    verified_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Biometric Verifications
CREATE TABLE kyc_biometric_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kyc_application_id UUID NOT NULL REFERENCES kyc_applications(id) ON DELETE CASCADE,
    
    -- Biometric Type
    biometric_type VARCHAR(20) NOT NULL CHECK (biometric_type IN ('face_liveness', 'face_match', 'fingerprint')),
    
    -- Verification Results
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed')),
    confidence_score DECIMAL(5,2),
    quality_score DECIMAL(5,2),
    
    -- Biometric Data (stored as file references for security)
    biometric_data_path VARCHAR(500),
    template_hash VARCHAR(128),
    
    -- Processing Details
    processing_provider VARCHAR(50),
    processing_response JSONB,
    
    -- Timestamps
    processed_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Compliance and Risk Screening
CREATE TABLE kyc_compliance_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kyc_application_id UUID NOT NULL REFERENCES kyc_applications(id) ON DELETE CASCADE,
    
    -- Check Type
    check_type VARCHAR(30) NOT NULL CHECK (check_type IN ('pep', 'sanctions', 'adverse_media', 'aml')),
    
    -- Check Results
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed', 'review_required')),
    risk_score DECIMAL(5,2) DEFAULT 0.00,
    match_count INTEGER DEFAULT 0,
    
    -- Check Data
    search_terms TEXT[],
    screening_results JSONB,
    hit_details JSONB,
    
    -- Provider Information
    screening_provider VARCHAR(50),
    provider_reference VARCHAR(100),
    
    -- Timestamps
    checked_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- KYC Status History (Audit Trail)
CREATE TABLE kyc_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kyc_application_id UUID NOT NULL REFERENCES kyc_applications(id) ON DELETE CASCADE,
    
    -- Status Change
    previous_status VARCHAR(20),
    new_status VARCHAR(20) NOT NULL,
    status_reason TEXT,
    
    -- Change Details
    changed_by UUID,
    change_type VARCHAR(30), -- 'automatic', 'manual_review', 'system_update'
    
    -- Additional Context
    metadata JSONB,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- KYC Audit Trail
CREATE TABLE kyc_audit_trail (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kyc_application_id UUID NOT NULL REFERENCES kyc_applications(id) ON DELETE CASCADE,
    
    -- Action Details
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50), -- 'application', 'document', 'verification'
    entity_id UUID,
    
    -- User Context
    user_id UUID REFERENCES users(id),
    officer_id UUID,
    
    -- Request Context
    ip_address INET,
    user_agent TEXT,
    request_id VARCHAR(100),
    
    -- Action Data
    old_values JSONB,
    new_values JSONB,
    metadata JSONB,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- KYC Configuration (for different tiers and rules)
CREATE TABLE kyc_configuration (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Configuration Details
    tier VARCHAR(10) NOT NULL,
    country_code VARCHAR(3) DEFAULT 'NG',
    
    -- Requirements
    required_documents TEXT[],
    required_verifications TEXT[],
    minimum_age INTEGER DEFAULT 18,
    maximum_income DECIMAL(15,2),
    
    -- Risk Thresholds
    risk_threshold_low DECIMAL(5,2) DEFAULT 30.00,
    risk_threshold_medium DECIMAL(5,2) DEFAULT 70.00,
    
    -- Processing Rules
    auto_approve_threshold DECIMAL(5,2) DEFAULT 95.00,
    auto_reject_threshold DECIMAL(5,2) DEFAULT 20.00,
    
    -- Validity Period
    validity_days INTEGER DEFAULT 365,
    
    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_kyc_applications_user_id ON kyc_applications(user_id);
CREATE INDEX idx_kyc_applications_status ON kyc_applications(overall_status);
CREATE INDEX idx_kyc_applications_tier ON kyc_applications(kyc_tier);
CREATE INDEX idx_kyc_documents_application_id ON kyc_documents(kyc_application_id);
CREATE INDEX idx_kyc_documents_type ON kyc_documents(document_type);
CREATE INDEX idx_kyc_documents_status ON kyc_documents(status);
CREATE INDEX idx_kyc_audit_trail_application_id ON kyc_audit_trail(kyc_application_id);
CREATE INDEX idx_kyc_audit_trail_created_at ON kyc_audit_trail(created_at);

-- =============================================================================
-- BACKEND API LOGIC (Node.js/Express with PostgreSQL)
-- =============================================================================