
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function testSignedUrl() {
    const filePath = "5ea16be7-26c6-42bf-b15a-35b18503855b/1778962268832-hajiya_fatima_agtcempro_inv_autogen.pdf";
    const bucket = "kyc-documents";

    console.log(`Testing bucket: ${bucket}, path: ${filePath}`);

    const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(filePath, 60);

    if (error) {
        console.error("Signed URL Error:", JSON.stringify(error, null, 2));
    } else {
        console.log("Signed URL success:", data.signedUrl);
    }
}

testSignedUrl();
