import express from "express";
import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";

const app = express();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Your T+1 settlement function
async function runDailySettlement() {
    console.log("Running T+1 settlements...");
    const { error } = await supabase.rpc("process_pending_deposits");
    if (error) {
        throw new Error(`Settlement error: ${JSON.stringify(error)}`);
    } else {
        console.log("Settlements completed successfully at", new Date());
    }
}

// Schedule it for 2 AM daily (server time)
cron.schedule("0 2 * * *", () => {
    runDailySettlement();
});

// Start your Express app normally
app.listen(3000, () => console.log("Server running on port 3000"));
