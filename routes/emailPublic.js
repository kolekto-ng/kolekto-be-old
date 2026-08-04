import express from 'express';
import { handleUnsubscribe } from '../controllers/emailUnsubscribe.js';

const router = express.Router();

// Public — no verifyToken/requireAdmin. This is what {{unsubscribe_link}}
// points recipients at; they're not admins and have no session.
router.get('/unsubscribe', handleUnsubscribe);

export default router;
