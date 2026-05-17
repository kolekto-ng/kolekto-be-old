
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function testSignedUrl() {
    const filePath = "5ea16be7-26c6-42bf-b15a-35b18503855b/1778831610814-selfie.jpg";
    const bucket = "kyc-documents";

    console.log(`Testing bucket: ${bucket}, path: ${filePath}`);

    const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(filePath, 60);

    if (error) {
        console.error("Error:", error);
    } else {
        console.log("Signed URL:", data.signedUrl);
    }
}

testSignedUrl();
