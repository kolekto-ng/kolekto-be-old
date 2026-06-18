import express from 'express';
import multer from 'multer';
import {
  acceptAmbassadorApplication,
  addAmbassadorApplicationNote,
  createAdminAmbassadorResource,
  deleteAdminAmbassadorResource,
  getAdminAmbassadorDetail,
  getAdminAmbassadorOverview,
  getAmbassadorApplication,
  listAdminAmbassadorResources,
  listAmbassadorApplications,
  reactivateAmbassador,
  rejectAmbassadorApplication,
  scheduleAmbassadorInterview,
  suspendAmbassador,
  updateAdminAmbassadorResource,
} from '../../controllers/ambassador.js';
import verifyToken from '../../utils/verifyToken.js';
import requireAdmin from '../../utils/requireAdmin.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

router.get('/ambassadors/applications', verifyToken, requireAdmin, listAmbassadorApplications);
router.get('/ambassadors/resources', verifyToken, requireAdmin, listAdminAmbassadorResources);
router.post('/ambassadors/resources', verifyToken, requireAdmin, upload.single('file'), createAdminAmbassadorResource);
router.patch('/ambassadors/resources/:id', verifyToken, requireAdmin, upload.single('file'), updateAdminAmbassadorResource);
router.delete('/ambassadors/resources/:id', verifyToken, requireAdmin, deleteAdminAmbassadorResource);
router.get('/ambassadors/applications/:id/detail', verifyToken, requireAdmin, getAdminAmbassadorDetail);
router.get('/ambassadors/applications/:id/overview', verifyToken, requireAdmin, getAdminAmbassadorOverview);
router.get('/ambassadors/applications/:id', verifyToken, requireAdmin, getAmbassadorApplication);
router.patch('/ambassadors/applications/:id/interview', verifyToken, requireAdmin, scheduleAmbassadorInterview);
router.post('/ambassadors/applications/:id/accept', verifyToken, requireAdmin, acceptAmbassadorApplication);
router.post('/ambassadors/applications/:id/reject', verifyToken, requireAdmin, rejectAmbassadorApplication);
router.post('/ambassadors/applications/:id/suspend', verifyToken, requireAdmin, suspendAmbassador);
router.post('/ambassadors/applications/:id/reactivate', verifyToken, requireAdmin, reactivateAmbassador);
router.post('/ambassadors/applications/:id/notes', verifyToken, requireAdmin, addAmbassadorApplicationNote);

export default router;
