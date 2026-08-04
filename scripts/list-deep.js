
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

async function listDeep(path = "") {
    const bucket = "kyc-documents";
    const { data: items, error } = await supabase.storage
        .from(bucket)
        .list(path);
        
    if (error) {
        console.error(`Error listing ${path}:`, error.message);
        return;
    }
    
    for (const item of items) {
        const fullPath = path ? `${path}/${item.name}` : item.name;
        if (item.id) {
            // It has an ID, so it's a file
            console.log(`FILE: ${fullPath}`);
        } else {
            // No ID, it's a folder
            console.log(`DIR : ${fullPath}`);
            await listDeep(fullPath);
        }
    }
}

listDeep();
