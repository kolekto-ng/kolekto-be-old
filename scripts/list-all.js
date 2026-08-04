
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

async function listAllFiles() {
    const bucket = "kyc-documents";
    const { data: folders, error: folderError } = await supabase.storage
        .from(bucket)
        .list();
        
    if (folderError) throw folderError;
    
    for (const folder of folders) {
        if (folder.id) { // It's a folder
            console.log(`Folder: ${folder.name}`);
            const { data: files } = await supabase.storage
                .from(bucket)
                .list(folder.name);
            files.forEach(f => console.log(`  - ${f.name}`));
        } else {
            console.log(`File: ${folder.name}`);
        }
    }
}

listAllFiles();
