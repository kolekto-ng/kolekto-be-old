import express from 'express';
import multer from 'multer';
import {
  listEmailCampaigns,
  createEmailCampaign,
  getEmailCampaign,
  updateEmailCampaign,
  deleteEmailCampaign,
  addEmailCampaignRecipients,
  listEmailCampaignRecipients,
  removeEmailCampaignRecipient,
  sendTestEmail,
  sendCampaignNow,
  scheduleCampaign,
  cancelCampaign,
  previewCampaignHtml,
  listMergeTags,
  searchEmailRecipients,
  previewAudience,
  exportCampaignAudience,
  listEmailTemplates,
  createEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplate,
  listEmailCampaignAttachments,
  uploadEmailCampaignAttachment,
  deleteEmailCampaignAttachment,
} from '../../controllers/admin/emailCampaigns.js';
import { listEmailLogs, getEmailAnalytics, handleZeptoMailWebhook } from '../../controllers/admin/emailAnalytics.js';
import verifyToken from '../../utils/verifyToken.js';
// Communications is SUPER-ADMIN only (Task 2) — every route below is gated.
import { requireSuperAdmin } from '../../utils/requireAdmin.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.get('/email/campaigns', verifyToken, requireSuperAdmin, listEmailCampaigns);
router.post('/email/campaigns', verifyToken, requireSuperAdmin, createEmailCampaign);
router.get('/email/campaigns/:id', verifyToken, requireSuperAdmin, getEmailCampaign);
router.patch('/email/campaigns/:id', verifyToken, requireSuperAdmin, updateEmailCampaign);
router.delete('/email/campaigns/:id', verifyToken, requireSuperAdmin, deleteEmailCampaign);
router.get('/email/campaigns/:id/preview-html', verifyToken, requireSuperAdmin, previewCampaignHtml);
router.get('/email/merge-tags', verifyToken, requireSuperAdmin, listMergeTags);
router.get('/email/recipients/search', verifyToken, requireSuperAdmin, searchEmailRecipients);

router.post('/email/campaigns/:id/recipients', verifyToken, requireSuperAdmin, addEmailCampaignRecipients);
router.get('/email/campaigns/:id/recipients', verifyToken, requireSuperAdmin, listEmailCampaignRecipients);
router.delete('/email/campaigns/:id/recipients/:recipientId', verifyToken, requireSuperAdmin, removeEmailCampaignRecipient);
router.post('/email/campaigns/:id/preview-audience', verifyToken, requireSuperAdmin, previewAudience);
router.get('/email/campaigns/:id/audience/export', verifyToken, requireSuperAdmin, exportCampaignAudience);

router.post('/email/campaigns/:id/test-send', verifyToken, requireSuperAdmin, sendTestEmail);
router.post('/email/campaigns/:id/send-now', verifyToken, requireSuperAdmin, sendCampaignNow);
router.post('/email/campaigns/:id/schedule', verifyToken, requireSuperAdmin, scheduleCampaign);
router.post('/email/campaigns/:id/cancel', verifyToken, requireSuperAdmin, cancelCampaign);

router.get('/email/campaigns/:id/attachments', verifyToken, requireSuperAdmin, listEmailCampaignAttachments);
router.post('/email/campaigns/:id/attachments', verifyToken, requireSuperAdmin, upload.single('file'), uploadEmailCampaignAttachment);
router.delete('/email/attachments/:attachmentId', verifyToken, requireSuperAdmin, deleteEmailCampaignAttachment);

router.get('/email/templates', verifyToken, requireSuperAdmin, listEmailTemplates);
router.post('/email/templates', verifyToken, requireSuperAdmin, createEmailTemplate);
router.patch('/email/templates/:id', verifyToken, requireSuperAdmin, updateEmailTemplate);
router.delete('/email/templates/:id', verifyToken, requireSuperAdmin, deleteEmailTemplate);

router.get('/email/logs', verifyToken, requireSuperAdmin, listEmailLogs);
router.get('/email/analytics', verifyToken, requireSuperAdmin, getEmailAnalytics);

// Token-verified, not admin-session-verified — ZeptoMail calls this
// directly, it doesn't have an admin login. See handleZeptoMailWebhook for
// the shared-secret check.
router.post('/email/webhooks/zeptomail', handleZeptoMailWebhook);

export default router;
