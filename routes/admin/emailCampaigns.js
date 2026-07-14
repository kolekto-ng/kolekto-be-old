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
import requireAdmin from '../../utils/requireAdmin.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.get('/email/campaigns', verifyToken, requireAdmin, listEmailCampaigns);
router.post('/email/campaigns', verifyToken, requireAdmin, createEmailCampaign);
router.get('/email/campaigns/:id', verifyToken, requireAdmin, getEmailCampaign);
router.patch('/email/campaigns/:id', verifyToken, requireAdmin, updateEmailCampaign);
router.delete('/email/campaigns/:id', verifyToken, requireAdmin, deleteEmailCampaign);
router.get('/email/campaigns/:id/preview-html', verifyToken, requireAdmin, previewCampaignHtml);
router.get('/email/merge-tags', verifyToken, requireAdmin, listMergeTags);
router.get('/email/recipients/search', verifyToken, requireAdmin, searchEmailRecipients);

router.post('/email/campaigns/:id/recipients', verifyToken, requireAdmin, addEmailCampaignRecipients);
router.get('/email/campaigns/:id/recipients', verifyToken, requireAdmin, listEmailCampaignRecipients);
router.delete('/email/campaigns/:id/recipients/:recipientId', verifyToken, requireAdmin, removeEmailCampaignRecipient);
router.post('/email/campaigns/:id/preview-audience', verifyToken, requireAdmin, previewAudience);
router.get('/email/campaigns/:id/audience/export', verifyToken, requireAdmin, exportCampaignAudience);

router.post('/email/campaigns/:id/test-send', verifyToken, requireAdmin, sendTestEmail);
router.post('/email/campaigns/:id/send-now', verifyToken, requireAdmin, sendCampaignNow);
router.post('/email/campaigns/:id/schedule', verifyToken, requireAdmin, scheduleCampaign);
router.post('/email/campaigns/:id/cancel', verifyToken, requireAdmin, cancelCampaign);

router.get('/email/campaigns/:id/attachments', verifyToken, requireAdmin, listEmailCampaignAttachments);
router.post('/email/campaigns/:id/attachments', verifyToken, requireAdmin, upload.single('file'), uploadEmailCampaignAttachment);
router.delete('/email/attachments/:attachmentId', verifyToken, requireAdmin, deleteEmailCampaignAttachment);

router.get('/email/templates', verifyToken, requireAdmin, listEmailTemplates);
router.post('/email/templates', verifyToken, requireAdmin, createEmailTemplate);
router.patch('/email/templates/:id', verifyToken, requireAdmin, updateEmailTemplate);
router.delete('/email/templates/:id', verifyToken, requireAdmin, deleteEmailTemplate);

router.get('/email/logs', verifyToken, requireAdmin, listEmailLogs);
router.get('/email/analytics', verifyToken, requireAdmin, getEmailAnalytics);

// Token-verified, not admin-session-verified — ZeptoMail calls this
// directly, it doesn't have an admin login. See handleZeptoMailWebhook for
// the shared-secret check.
router.post('/email/webhooks/zeptomail', handleZeptoMailWebhook);

export default router;
