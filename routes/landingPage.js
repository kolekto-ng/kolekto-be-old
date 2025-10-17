import express from "express";
import { getCampuses, joinCampus } from "../controllers/kolektoOnCampus.js";

const router = express.Router();

router.get("/campuses", getCampuses);
router.post("/join-campus", joinCampus);


export default router;
