import { supabase } from '../services/supabaseClient';
export const checkBlockedIp = async (ip) => {
    const { data, error } = await supabase
        .from("users")
        .select("blocked_until")
        .eq('signup_ip', ip)
        .order('blocked_until', { ascending: false })
        .limit(1);

    if (error) throw error;

    if (data.length && data[0].blocked_until) {
        const blockedUntil = new Date(data[0].blocked_until);
        if (blockedUntil > new Date()) {
            return true; // still blocked
        }
    }
    return false
}