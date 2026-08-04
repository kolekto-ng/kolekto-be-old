
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

async function findGlobal(fileName) {
    const { data: buckets } = await supabase.storage.listBuckets();
    for (const bucket of buckets) {
        console.log(`Searching bucket: ${bucket.name}...`);
        await searchRecursive(bucket.name, "", fileName);
    }
}

async function searchRecursive(bucket, path, fileName) {
    const { data: items } = await supabase.storage.from(bucket).list(path);
    if (!items) return;
    for (const item of items) {
        const fullPath = path ? `${path}/${item.name}` : item.name;
        if (item.name.includes(fileName)) {
            console.log(`  ✅ FOUND: ${bucket}/${fullPath}`);
        }
        if (!item.id) { // Folder
            await searchRecursive(bucket, fullPath, fileName);
        }
    }
}

findGlobal("hajiya_fatima");
