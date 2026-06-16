
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

async function findFile() {
    const fileName = "1778962268832-hajiya_fatima_agtcempro_inv_autogen.pdf";
    const userId = "5ea16be7-26c6-42bf-b15a-35b18503855b";
    
    const { data: buckets } = await supabase.storage.listBuckets();
    
    for (const bucket of buckets) {
        console.log(`Checking bucket: ${bucket.name}`);
        const { data: files, error } = await supabase.storage
            .from(bucket.name)
            .list(userId);
            
        if (error) {
            console.error(`  Error listing ${bucket.name}:`, error.message);
            continue;
        }
        
        const found = files.find(f => f.name === fileName);
        if (found) {
            console.log(`  ✅ FOUND in ${bucket.name}!`);
        } else {
            console.log(`  ❌ Not found in ${bucket.name}`);
        }
    }
}

findFile();
