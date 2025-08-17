// =============================================================================
// KYC BACKEND API IMPLEMENTATION (Node.js/Express)
// =============================================================================

const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');

const router = express.Router();

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = `uploads/kyc/${req.user.id}`;
    fs.mkdir(uploadDir, { recursive: true }).then(() => {
      cb(null, uploadDir);
    });
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only images and PDF files are allowed'));
    }
  }
});

// =============================================================================
// KYC SERVICE CLASSES
// =============================================================================

class KYCService {
  // Initialize KYC application
  static async initializeKYC(userId, tier = 'tier_1') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Generate application reference
      const applicationRef = `KYC${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

      // Create KYC application
      const kycQuery = `
        INSERT INTO kyc_applications (user_id, kyc_tier, application_reference)
        VALUES ($1, $2, $3)
        RETURNING *
      `;
      const kycResult = await client.query(kycQuery, [userId, tier, applicationRef]);
      const kycApplication = kycResult.rows[0];

      // Log audit trail
      await this.logAuditTrail(client, kycApplication.id, 'kyc_initiated', 'application', kycApplication.id, userId);

      await client.query('COMMIT');
      return kycApplication;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Update personal information
  static async updatePersonalInfo(kycApplicationId, personalData, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if personal info exists
      const existingQuery = 'SELECT id FROM kyc_personal_info WHERE kyc_application_id = $1';
      const existingResult = await client.query(existingQuery, [kycApplicationId]);

      let personalInfo;
      if (existingResult.rows.length > 0) {
        // Update existing
        const updateQuery = `
          UPDATE kyc_personal_info SET
            first_name = $2, middle_name = $3, last_name = $4, date_of_birth = $5,
            gender = $6, nationality = $7, state_of_origin = $8, local_government_area = $9,
            marital_status = $10, occupation = $11, employer_name = $12, monthly_income = $13,
            source_of_funds = $14, residential_address = $15, nok_name = $16,
            nok_relationship = $17, nok_phone_number = $18, nok_email = $19,
            updated_at = NOW()
          WHERE kyc_application_id = $1
          RETURNING *
        `;
        const result = await client.query(updateQuery, [
          kycApplicationId, personalData.firstName, personalData.middleName,
          personalData.lastName, personalData.dateOfBirth, personalData.gender,
          personalData.nationality, personalData.stateOfOrigin, personalData.lga,
          personalData.maritalStatus, personalData.occupation, personalData.employerName,
          personalData.monthlyIncome, personalData.sourceOfFunds, personalData.residentialAddress,
          personalData.nokName, personalData.nokRelationship, personalData.nokPhoneNumber,
          personalData.nokEmail
        ]);
        personalInfo = result.rows[0];
      } else {
        // Insert new
        const insertQuery = `
          INSERT INTO kyc_personal_info (
            kyc_application_id, first_name, middle_name, last_name, date_of_birth,
            gender, nationality, state_of_origin, local_government_area, marital_status,
            occupation, employer_name, monthly_income, source_of_funds, residential_address,
            nok_name, nok_relationship, nok_phone_number, nok_email
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
          RETURNING *
        `;
        const result = await client.query(insertQuery, [
          kycApplicationId, personalData.firstName, personalData.middleName,
          personalData.lastName, personalData.dateOfBirth, personalData.gender,
          personalData.nationality, personalData.stateOfOrigin, personalData.lga,
          personalData.maritalStatus, personalData.occupation, personalData.employerName,
          personalData.monthlyIncome, personalData.sourceOfFunds, personalData.residentialAddress,
          personalData.nokName, personalData.nokRelationship, personalData.nokPhoneNumber,
          personalData.nokEmail
        ]);
        personalInfo = result.rows[0];
      }

      // Update application progress
      await this.updateApplicationProgress(client, kycApplicationId);

      // Log audit trail
      await this.logAuditTrail(client, kycApplicationId, 'personal_info_updated', 'personal_info', personalInfo.id, userId);

      await client.query('COMMIT');
      return personalInfo;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Upload document
  static async uploadDocument(kycApplicationId, documentData, userId, ipAddress, userAgent) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Generate file hash
      const fileBuffer = await fs.readFile(documentData.filePath);
      const fileHash = require('crypto').createHash('sha256').update(fileBuffer).digest('hex');

      // Insert document record
      const documentQuery = `
        INSERT INTO kyc_documents (
          kyc_application_id, document_type, document_category, file_name,
          file_path, file_size, file_type, file_hash, document_number,
          uploaded_by, ip_address, user_agent
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `;

      const documentResult = await client.query(documentQuery, [
        kycApplicationId, documentData.documentType, documentData.documentCategory,
        documentData.fileName, documentData.filePath, documentData.fileSize,
        documentData.fileType, fileHash, documentData.documentNumber,
        userId, ipAddress, userAgent
      ]);

      const document = documentResult.rows[0];

      // Process document (OCR, quality check, etc.)
      await this.processDocument(document.id);

      // Update application progress
      await this.updateApplicationProgress(client, kycApplicationId);

      // Log audit trail
      await this.logAuditTrail(client, kycApplicationId, 'document_uploaded', 'document', document.id, userId, {
        documentType: documentData.documentType,
        fileName: documentData.fileName
      });

      await client.query('COMMIT');
      return document;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Process document (OCR, validation, etc.)
  static async processDocument(documentId) {
    try {
      const documentQuery = 'SELECT * FROM kyc_documents WHERE id = $1';
      const documentResult = await pool.query(documentQuery, [documentId]);
      const document = documentResult.rows[0];

      if (!document) throw new Error('Document not found');

      let ocrData = {};
      let qualityScore = 0;

      // OCR processing for images
      if (document.file_type.startsWith('image/')) {
        // Integrate with OCR service (e.g., Google Vision API, AWS Textract)
        ocrData = await this.performOCR(document.file_path);
        qualityScore = await this.assessImageQuality(document.file_path);
      }

      // Update document with processing results
      const updateQuery = `
        UPDATE kyc_documents SET
          ocr_data = $2,
          quality_score = $3,
          status = $4,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `;

      const status = qualityScore > 70 ? 'approved' : 'rejected';
      const result = await pool.query(updateQuery, [documentId, JSON.stringify(ocrData), qualityScore, status]);

      return result.rows[0];

    } catch (error) {
      console.error('Document processing error:', error);
      throw error;
    }
  }

  // Verify NIN
  static async verifyNIN(kycApplicationId, ninNumber, userId) {
    try {
      // Call NIN verification API (integrate with NIMC or third-party provider)
      const verificationResponse = await this.callNINVerificationAPI(ninNumber);

      // Store verification result
      const verificationQuery = `
        INSERT INTO kyc_government_verifications (
          kyc_application_id, verification_type, id_number, masked_id_number,
          status, match_score, verification_data, verification_response,
          verification_provider, verified_at
        ) VALUES ($1, 'nin', $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING *
      `;

      const maskedNIN = ninNumber.substring(0, 3) + '*'.repeat(5) + ninNumber.substring(8);
      const matchScore = verificationResponse.match_score || 0;
      const status = matchScore > 80 ? 'verified' : 'failed';

      const result = await pool.query(verificationQuery, [
        kycApplicationId, ninNumber, maskedNIN, status, matchScore,
        JSON.stringify(verificationResponse.data), JSON.stringify(verificationResponse),
        'nin_provider'
      ]);

      return result.rows[0];

    } catch (error) {
      console.error('NIN verification error:', error);
      throw error;
    }
  }

  // Verify BVN
  static async verifyBVN(kycApplicationId, bvnNumber, userId) {
    try {
      // Call BVN verification API
      const verificationResponse = await this.callBVNVerificationAPI(bvnNumber);

      // Store verification result
      const verificationQuery = `
        INSERT INTO kyc_government_verifications (
          kyc_application_id, verification_type, id_number, masked_id_number,
          status, match_score, verification_data, verification_response,
          verification_provider, verified_at
        ) VALUES ($1, 'bvn', $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING *
      `;

      const maskedBVN = bvnNumber.substring(0, 3) + '*'.repeat(5) + bvnNumber.substring(8);
      const matchScore = verificationResponse.match_score || 0;
      const status = matchScore > 80 ? 'verified' : 'failed';

      const result = await pool.query(verificationQuery, [
        kycApplicationId, bvnNumber, maskedBVN, status, matchScore,
        JSON.stringify(verificationResponse.data), JSON.stringify(verificationResponse),
        'bvn_provider'
      ]);

      return result.rows[0];

    } catch (error) {
      console.error('BVN verification error:', error);
      throw error;
    }
  }

  // Verify bank account
  static async verifyBankAccount(kycApplicationId, bankDetails, userId) {
    try {
      // Call bank account verification API
      const verificationResponse = await this.callBankVerificationAPI(bankDetails);

      // Store verification result
      const verificationQuery = `
        INSERT INTO kyc_bank_verifications (
          kyc_application_id, bank_name, bank_code, account_number, account_name,
          status, match_score, verification_response, verification_provider, verified_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        RETURNING *
      `;

      const matchScore = verificationResponse.match_score || 0;
      const status = matchScore > 80 ? 'verified' : 'failed';

      const result = await pool.query(verificationQuery, [
        kycApplicationId, bankDetails.bankName, bankDetails.bankCode,
        bankDetails.accountNumber, verificationResponse.account_name,
        status, matchScore, JSON.stringify(verificationResponse), 'bank_provider'
      ]);

      return result.rows[0];

    } catch (error) {
      console.error('Bank account verification error:', error);
      throw error;
    }
  }

  // Run compliance checks
  static async runComplianceChecks(kycApplicationId, personalData) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const checkTypes = ['pep', 'sanctions', 'adverse_media', 'aml'];
      const results = [];

      for (const checkType of checkTypes) {
        const checkResult = await this.performComplianceCheck(checkType, personalData);

        const insertQuery = `
          INSERT INTO kyc_compliance_checks (
            kyc_application_id, check_type, status, risk_score, match_count,
            screening_results, screening_provider, checked_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          RETURNING *
        `;

        const result = await client.query(insertQuery, [
          kycApplicationId, checkType, checkResult.status, checkResult.riskScore,
          checkResult.matchCount, JSON.stringify(checkResult.results), 'compliance_provider'
        ]);

        results.push(result.rows[0]);
      }

      await client.query('COMMIT');
      return results;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Update application progress
  static async updateApplicationProgress(client, kycApplicationId) {
    // Calculate completion percentage based on completed steps
    const progressQuery = `
      WITH progress_data AS (
        SELECT 
          ka.id,
          CASE WHEN kpi.id IS NOT NULL THEN 20 ELSE 0 END as personal_info_score,
          COALESCE(
            (SELECT COUNT(*) * 15 FROM kyc_documents WHERE kyc_application_id = ka.id AND status = 'approved'),
            0
          ) as documents_score,
          COALESCE(
            (SELECT COUNT(*) * 10 FROM kyc_government_verifications WHERE kyc_application_id = ka.id AND status = 'verified'),
            0
          ) as gov_verifications_score,
          COALESCE(
            (SELECT COUNT(*) * 10 FROM kyc_contact_verifications WHERE kyc_application_id = ka.id AND status = 'verified'),
            0
          ) as contact_verifications_score,
          COALESCE(
            (SELECT COUNT(*) * 15 FROM kyc_bank_verifications WHERE kyc_application_id = ka.id AND status = 'verified'),
            0
          ) as bank_verification_score
        FROM kyc_applications ka
        LEFT JOIN kyc_personal_info kpi ON ka.id = kpi.kyc_application_id
        WHERE ka.id = $1
      )
      UPDATE kyc_applications 
      SET completion_percentage = LEAST(
        (personal_info_score + documents_score + gov_verifications_score + contact_verifications_score + bank_verification_score),
        100
      ),
      updated_at = NOW()
      FROM progress_data
      WHERE kyc_applications.id = progress_data.id
      RETURNING completion_percentage
    `;

    const result = await client.query(progressQuery, [kycApplicationId]);
    return result.rows[0]?.completion_percentage || 0;
  }

  // Log audit trail
  static async logAuditTrail(client, kycApplicationId, action, entityType, entityId, userId, metadata = {}) {
    const auditQuery = `
      INSERT INTO kyc_audit_trail (
        kyc_application_id, action, entity_type, entity_id, user_id, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `;

    await client.query(auditQuery, [
      kycApplicationId, action, entityType, entityId, userId, JSON.stringify(metadata)
    ]);
  }

  // Mock API calls (replace with actual integrations)
  static async callNINVerificationAPI(ninNumber) {
    // Mock response - integrate with actual NIN verification service
    return {
      status: 'success',
      match_score: 95.5,
      data: {
        first_name: 'John',
        last_name: 'Doe',
        date_of_birth: '1990-01-15',
        gender: 'male'
      }
    };
  }

  static async callBVNVerificationAPI(bvnNumber) {
    // Mock response - integrate with actual BVN verification service
    return {
      status: 'success',
      match_score: 92.3,
      data: {
        first_name: 'John',
        last_name: 'Doe',
        date_of_birth: '1990-01-15',
        phone_number: '+2341234567890'
      }
    };
  }

  static async callBankVerificationAPI(bankDetails) {
    // Mock response - integrate with actual bank verification service
    return {
      status: 'success',
      match_score: 88.7,
      account_name: 'John Michael Doe'
    };
  }

  static async performOCR(filePath) {
    // Mock OCR - integrate with actual OCR service
    return {
      extracted_text: 'Sample extracted text from document',
      confidence: 92.5
    };
  }

  static async assessImageQuality(filePath) {
    // Mock quality assessment - integrate with actual image quality service
    return 85.2;
  }

  static async performComplianceCheck(checkType, personalData) {
    // Mock compliance check - integrate with actual compliance service
    return {
      status: 'passed',
      riskScore: 15.5,
      matchCount: 0,
      results: { clean: true }
    };
  }
}

// =============================================================================
// API ROUTES
// =============================================================================

// Initialize KYC
router.post('/initialize', async (req, res) => {
  try {
    const { tier = 'tier_1' } = req.body;
    const kycApplication = await KYCService.initializeKYC(req.user.id, tier);

    res.status(201).json({
      success: true,
      data: kycApplication,
      message: 'KYC application initialized successfully'
    });
  } catch (error) {
    console.error('Initialize KYC error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initialize KYC application'
    });
  }
});

// Update personal information
router.put('/:kycId/personal-info', async (req, res) => {
  try {
    const { kycId } = req.params;
    const personalData = req.body;

    const personalInfo = await KYCService.updatePersonalInfo(kycId, personalData, req.user.id);

    res.json({
      success: true,
      data: personalInfo,
      message: 'Personal information updated successfully'
    });
  } catch (error) {
    console.error('Update personal info error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update personal information'
    });
  }
});

// Upload document
router.post('/:kycId/documents', upload.single('document'), async (req, res) => {
  try {
    const { kycId } = req.params;
    const { documentType, documentCategory, documentNumber } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const documentData = {
      documentType,
      documentCategory,
      fileName: req.file.originalname,
      filePath: req.file.path,
      fileSize: req.file.size,
      fileType: req.file.mimetype,
      documentNumber
    };

    const document = await KYCService.uploadDocument(
      kycId,
      documentData,
      req.user.id,
      req.ip,
      req.get('User-Agent')
    );

    res.status(201).json({
      success: true,
      data: document,
      message: 'Document uploaded successfully'
    });
  } catch (error) {
    console.error('Upload document error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload document'
    });
  }
});

// Verify NIN
router.post('/:kycId/verify-nin', async (req, res) => {
  try {
    const { kycId } = req.params;
    const { ninNumber } = req.body;

    if (!ninNumber || ninNumber.length !== 11) {
      return res.status(400).json({
        success: false,
        message: 'Valid NIN number is required'
      });
    }

    const verification = await KYCService.verifyNIN(kycId, ninNumber, req.user.id);

    res.json({
      success: true,
      data: verification,
      message: 'NIN verification completed'
    });
  } catch (error) {
    console.error('NIN verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify NIN'
    });
  }
});

// Verify BVN
router.post('/:kycId/verify-bvn', async (req, res) => {
  try {
    const { kycId } = req.params;
    const { bvnNumber } = req.body;

    if (!bvnNumber || bvnNumber.length !== 11) {
      return res.status(400).json({
        success: false,
        message: 'Valid BVN number is required'
      });
    }

    const verification = await KYCService.verifyBVN(kycId, bvnNumber, req.user.id);

    res.json({
      success: true,
      data: verification,
      message: 'BVN verification completed'
    });
  } catch (error) {
    console.error('BVN verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify BVN'
    });
  }
});

// Verify bank account
router.post('/:kycId/verify-bank', async (req, res) => {
  try {
    const { kycId } = req.params;
    const bankDetails = req.body;

    const verification = await KYCService.verifyBankAccount(kycId, bankDetails, req.user.id);

    res.json({
      success: true,
      data: verification,
      message: 'Bank account verification completed'
    });
  } catch (error) {
    console.error('Bank verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify bank account'
    });
  }
});

// Get KYC status
router.get('/:kycId', async (req, res) => {
  try {
    const { kycId } = req.params;

    const kycQuery = `
      SELECT 
        ka.*,
        kpi.first_name, kpi.last_name, kpi.date_of_birth,
        array_agg(DISTINCT kd.document_type) as uploaded_documents,
        array_agg(DISTINCT kgv.verification_type) as completed_verifications
      FROM kyc_applications ka
      LEFT JOIN kyc_personal_info kpi ON ka.id = kpi.kyc_application_id
      LEFT JOIN kyc_documents kd ON ka.id = kd.kyc_application_id AND kd.status = 'approved'
      LEFT JOIN kyc_government_verifications kgv ON ka.id = kgv.kyc_application_id AND kgv.status = 'verified'
      WHERE ka.id = $1 AND ka.user_id = $2
      GROUP BY ka.id, kpi.first_name, kpi.last_name, kpi.date_of_birth
    `;

    const result = await pool.query(kycQuery, [kycId, req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'KYC application not found'
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Get KYC status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch KYC status'
    });
  }
});

// Run compliance checks
router.post('/:kycId/compliance-check', async (req, res) => {
  try {
    const { kycId } = req.params;

    // Get personal info for compliance checks
    const personalInfoQuery = 'SELECT * FROM kyc_personal_info WHERE kyc_application_id = $1';
    const personalInfoResult = await pool.query(personalInfoQuery, [kycId]);

    if (personalInfoResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Personal information required for compliance checks'
      });
    }

    const personalData = personalInfoResult.rows[0];
    const complianceResults = await KYCService.runComplianceChecks(kycId, personalData);

    res.json({
      success: true,
      data: complianceResults,
      message: 'Compliance checks completed'
    });
  } catch (error) {
    console.error('Compliance check error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to run compliance checks'
    });
  }
});

// Submit KYC for review
router.post('/:kycId/submit', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { kycId } = req.params;

    // Check if KYC is ready for submission
    const readinessQuery = `
      SELECT 
        ka.completion_percentage,
        ka.overall_status,
        COUNT(DISTINCT kd.id) as document_count,
        COUNT(DISTINCT kgv.id) as verification_count
      FROM kyc_applications ka
      LEFT JOIN kyc_documents kd ON ka.id = kd.kyc_application_id AND kd.status = 'approved'
      LEFT JOIN kyc_government_verifications kgv ON ka.id = kgv.kyc_application_id AND kgv.status = 'verified'
      LEFT JOIN kyc_personal_info kpi ON ka.id = kpi.kyc_application_id
      WHERE ka.id = $1 AND ka.user_id = $2
      GROUP BY ka.id, ka.completion_percentage, ka.overall_status
    `;

    const readinessResult = await client.query(readinessQuery, [kycId, req.user.id]);

    if (readinessResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'KYC application not found'
      });
    }

    const kycData = readinessResult.rows[0];

    if (kycData.completion_percentage < 80) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'KYC application is not complete enough for submission'
      });
    }

    // Update status to submitted
    const updateQuery = `
      UPDATE kyc_applications 
      SET overall_status = 'in_progress', submitted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `;

    const updateResult = await client.query(updateQuery, [kycId, req.user.id]);

    // Log status change
    await client.query(`
      INSERT INTO kyc_status_history (kyc_application_id, previous_status, new_status, changed_by, change_type)
      VALUES ($1, $2, 'in_progress', $3, 'manual_submission')
    `, [kycId, kycData.overall_status, req.user.id]);

    // Log audit trail
    await KYCService.logAuditTrail(client, kycId, 'kyc_submitted', 'application', kycId, req.user.id);

    await client.query('COMMIT');

    res.json({
      success: true,
      data: updateResult.rows[0],
      message: 'KYC application submitted successfully'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Submit KYC error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit KYC application'
    });
  } finally {
    client.release();
  }
});

module.exports = router;

// =============================================================================
// ADDITIONAL UTILITY FUNCTIONS
// =============================================================================

class KYCValidationService {
  // Validate Nigerian phone number
  static validateNigerianPhone(phoneNumber) {
    const phoneRegex = /^\+234[7-9][0-1]\d{8}$/;
    return phoneRegex.test(phoneNumber);
  }

  // Validate Nigerian NIN
  static validateNIN(nin) {
    if (!nin || nin.length !== 11) return false;
    return /^\d{11}$/.test(nin);
  }

  // Validate Nigerian BVN
  static validateBVN(bvn) {
    if (!bvn || bvn.length !== 11) return false;
    return /^\d{11}$/.test(bvn);
  }

  // Validate age requirement
  static validateAge(dateOfBirth, minimumAge = 18) {
    const today = new Date();
    const birthDate = new Date(dateOfBirth);
    const age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }

    return age >= minimumAge;
  }

  // Calculate risk score based on various factors
  static calculateRiskScore(kycData) {
    let riskScore = 0;

    // Age factor
    const age = this.calculateAge(kycData.personalInfo?.dateOfBirth);
    if (age < 25) riskScore += 5;
    if (age > 65) riskScore += 10;

    // Income factor
    const monthlyIncome = parseFloat(kycData.personalInfo?.monthlyIncome || 0);
    if (monthlyIncome > 10000000) riskScore += 15; // High income flag
    if (monthlyIncome < 50000) riskScore += 5;

    // Document quality
    const avgQualityScore = kycData.documents?.reduce((sum, doc) => sum + (doc.qualityScore || 0), 0) / (kycData.documents?.length || 1);
    if (avgQualityScore < 70) riskScore += 10;

    // Verification match scores
    const ninMatch = kycData.governmentVerifications?.nin?.matchScore || 0;
    const bvnMatch = kycData.governmentVerifications?.bvn?.matchScore || 0;
    if (ninMatch < 90 || bvnMatch < 90) riskScore += 15;

    // Compliance flags
    if (kycData.complianceChecks?.pep) riskScore += 25;
    if (kycData.complianceChecks?.sanctions) riskScore += 50;
    if (kycData.complianceChecks?.adverseMedia) riskScore += 20;

    return Math.min(riskScore, 100); // Cap at 100
  }

  // Calculate age from date of birth
  static calculateAge(dateOfBirth) {
    if (!dateOfBirth) return 0;
    const today = new Date();
    const birthDate = new Date(dateOfBirth);
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }

    return age;
  }
}

class KYCNotificationService {
  // Send KYC status update notifications
  static async sendStatusNotification(userId, kycApplicationId, status, message) {
    try {
      // Integration with notification service (email, SMS, push notifications)
      console.log(`Sending notification to user ${userId}: KYC ${status} - ${message}`);

      // Example: Send email notification
      // await emailService.send({
      //   to: userEmail,
      //   subject: `KYC Application ${status}`,
      //   template: 'kyc-status-update',
      //   data: { status, message, applicationId: kycApplicationId }
      // });

      // Example: Send SMS notification
      // await smsService.send({
      //   to: userPhone,
      //   message: `Your KYC application status: ${status}. ${message}`
      // });

    } catch (error) {
      console.error('Notification sending error:', error);
    }
  }

  // Send document rejection notification
  static async sendDocumentRejectionNotification(userId, documentType, rejectionReason) {
    try {
      const message = `Your ${documentType} document was rejected. Reason: ${rejectionReason}. Please upload a new document.`;
      await this.sendStatusNotification(userId, null, 'Document Rejected', message);
    } catch (error) {
      console.error('Document rejection notification error:', error);
    }
  }
}

// =============================================================================
// CRON JOBS FOR KYC MAINTENANCE
// =============================================================================

const cron = require('node-cron');

// Run daily KYC maintenance tasks
cron.schedule('0 2 * * *', async () => {
  console.log('Running daily KYC maintenance tasks...');

  try {
    // Clean up expired KYC applications
    await pool.query(`
      UPDATE kyc_applications 
      SET overall_status = 'expired', updated_at = NOW()
      WHERE expires_at < NOW() AND overall_status NOT IN ('approved', 'rejected')
    `);

    // Clean up old temporary files
    const oldDocuments = await pool.query(`
      SELECT file_path FROM kyc_documents 
      WHERE created_at < NOW() - INTERVAL '30 days' 
      AND status = 'rejected'
    `);

    for (const doc of oldDocuments.rows) {
      try {
        await fs.unlink(doc.file_path);
      } catch (error) {
        console.error('File cleanup error:', error);
      }
    }

    console.log('KYC maintenance tasks completed');

  } catch (error) {
    console.error('KYC maintenance error:', error);
  }
});

// Run weekly compliance re-screening for high-risk users
cron.schedule('0 3 * * 0', async () => {
  console.log('Running weekly compliance re-screening...');

  try {
    const highRiskUsers = await pool.query(`
      SELECT id, user_id FROM kyc_applications 
      WHERE risk_level = 'high' 
      AND overall_status = 'approved'
      AND updated_at < NOW() - INTERVAL '7 days'
    `);

    for (const kycApp of highRiskUsers.rows) {
      // Re-run compliance checks
      const personalInfo = await pool.query(
        'SELECT * FROM kyc_personal_info WHERE kyc_application_id = $1',
        [kycApp.id]
      );

      if (personalInfo.rows.length > 0) {
        await KYCService.runComplianceChecks(kycApp.id, personalInfo.rows[0]);
      }
    }

    console.log('Weekly compliance re-screening completed');

  } catch (error) {
    console.error('Compliance re-screening error:', error);
  }
});

// Export services for use in other modules
module.exports = {
  KYCService,
  KYCValidationService,
  KYCNotificationService
};