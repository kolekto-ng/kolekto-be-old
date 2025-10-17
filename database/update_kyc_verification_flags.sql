-- Function to update KYC verification flags based on document status
CREATE OR REPLACE FUNCTION update_kyc_verification_flags()
RETURNS TRIGGER AS $$
DECLARE
    user_uuid UUID;
    identity_verified BOOLEAN := FALSE;
    address_verified BOOLEAN := FALSE;
    bank_verified BOOLEAN := FALSE;
    bvn_verified BOOLEAN := FALSE;
    all_verified BOOLEAN := FALSE;
BEGIN
    -- Get the user_id from the updated document
    user_uuid := NEW.user_id;
    
    -- Check if all documents of each type are verified
    SELECT 
        -- Identity documents: all must be verified
        NOT EXISTS (
            SELECT 1 FROM kyc_documents 
            WHERE user_id = user_uuid 
            AND document_type = 'identity' 
            AND status != 'verified'
        ),
        -- Address documents: all must be verified
        NOT EXISTS (
            SELECT 1 FROM kyc_documents 
            WHERE user_id = user_uuid 
            AND document_type = 'address' 
            AND status != 'verified'
        ),
        -- Bank documents: all must be verified
        NOT EXISTS (
            SELECT 1 FROM kyc_documents 
            WHERE user_id = user_uuid 
            AND document_type = 'bank' 
            AND status != 'verified'
        ),
        -- BVN documents: all must be verified
        NOT EXISTS (
            SELECT 1 FROM kyc_documents 
            WHERE user_id = user_uuid 
            AND document_type = 'bvn' 
            AND status != 'verified'
        )
    INTO identity_verified, address_verified, bank_verified, bvn_verified;
    
    -- Check if at least one document of each type exists and is verified
    -- For types that don't have documents, we'll consider them as not verified
    identity_verified := identity_verified AND EXISTS (
        SELECT 1 FROM kyc_documents 
        WHERE user_id = user_uuid AND document_type = 'identity'
    );
    
    address_verified := address_verified AND EXISTS (
        SELECT 1 FROM kyc_documents 
        WHERE user_id = user_uuid AND document_type = 'address'
    );
    
    bank_verified := bank_verified AND EXISTS (
        SELECT 1 FROM kyc_documents 
        WHERE user_id = user_uuid AND document_type = 'bank'
    );
    
    bvn_verified := bvn_verified AND EXISTS (
        SELECT 1 FROM kyc_documents 
        WHERE user_id = user_uuid AND document_type = 'bvn'
    );
    
    -- Check if all verifications are complete
    all_verified := identity_verified AND address_verified AND bank_verified AND bvn_verified;
    
    -- Update the kyc_verifications table
    UPDATE kyc_verifications 
    SET 
        identity_verified = identity_verified,
        address_verified = address_verified,
        bank_verified = bank_verified,
        bvn_verified = bvn_verified,
        status = CASE 
            WHEN all_verified THEN 'verified'
            WHEN status = 'verified' AND NOT all_verified THEN 'pending'
            ELSE status
        END,
        completed_at = CASE 
            WHEN all_verified AND completed_at IS NULL THEN NOW()
            WHEN NOT all_verified THEN NULL
            ELSE completed_at
        END,
        updated_at = NOW()
    WHERE user_id = user_uuid;
    
    -- If no kyc_verifications record exists, create one
    IF NOT FOUND THEN
        INSERT INTO kyc_verifications (
            user_id, 
            identity_verified, 
            address_verified, 
            bank_verified, 
            bvn_verified,
            status,
            completed_at,
            created_at,
            updated_at
        ) VALUES (
            user_uuid,
            identity_verified,
            address_verified,
            bank_verified,
            bvn_verified,
            CASE WHEN all_verified THEN 'verified' ELSE 'pending' END,
            CASE WHEN all_verified THEN NOW() ELSE NULL END,
            NOW(),
            NOW()
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the trigger
DROP TRIGGER IF EXISTS kyc_documents_status_trigger ON kyc_documents;

CREATE TRIGGER kyc_documents_status_trigger
    AFTER UPDATE ON kyc_documents
    FOR EACH ROW
    EXECUTE FUNCTION update_kyc_verification_flags();

-- Also create trigger for INSERT to handle new documents
CREATE TRIGGER kyc_documents_insert_trigger
    AFTER INSERT ON kyc_documents
    FOR EACH ROW
    EXECUTE FUNCTION update_kyc_verification_flags();

