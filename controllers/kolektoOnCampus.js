import { supabase } from "../utils/client.js";

export const getCampuses = async (req, res, next) => {

    const { data, error } = await supabase
        .from('campuses')
        .select(`*`)
        .order('campus_name', { ascending: true });
    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.status(200).json(data);
}

export const joinCampus = async (req, res, next) => {
    const { first_name, last_name, email, phone_number, campus, other_campus } = req.body;

    // 1. Check for missing fields
    if (!first_name || !last_name || !email || !phone_number || !campus) {
        return res.status(400).json({ message: "All fields are required." });
    }

    // 2. Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ message: "Invalid email format." });
    }

    // 3. Validate phone number format (Nigerian numbers: 10-15 digits, starts with 0 or +234)
    const phoneRegex = /^(?:\+234|0)[789][01]\d{8}$/;
    if (!phoneRegex.test(phone_number)) {
        return res.status(400).json({ message: "Invalid phone number format." });
    }

    // 4. Check if email or phone number already exists
    const { data: existingStudent, error: studentError } = await supabase
        .from('students')
        .select('student_id')
        .or(`email.eq.${email},phone_number.eq.${phone_number}`)
        .single();

    if (studentError && studentError.code !== 'PGRST116') { // PGRST116: No rows found
        return res.status(500).json({ message: "Error checking student records." });
    }
    if (existingStudent) {
        return res.status(409).json({ message: "Email or phone number already registered." });
    }

    // 5. Verify campus exists and get campus_id
    const { data: campusRow, error: campusError } = await supabase
        .from('campuses')
        .select('campus_id')
        .eq('campus_name', campus)
        .single();

    if (campusError || !campusRow) {
        return res.status(400).json({ message: "Selected campus does not exist." });
    }

    // 6. Insert new student
    const { data: newStudent, error: insertError } = await supabase
        .from('students')
        .insert([{
            first_name,
            last_name,
            email,
            phone_number,
            campus_id: campusRow.campus_id,
            other_campus: other_campus || null
        }])
        .select()
        .single();

    if (insertError) {
        return res.status(500).json({ message: "Failed to join campus.", details: insertError.message });
    }

    return res.status(201).json({ message: "Successfully joined campus!", student: newStudent });
};