import express from 'express';
import {
  ambassadorSignIn,
  getAmbassadorBadges,
  getAmbassadorEarnings,
  getAmbassadorLeaderboard,
  getAmbassadorMe,
  getAmbassadorOverview,
  getAmbassadorPayoutAccounts,
  getAmbassadorResources,
  getAmbassadorWithdrawals,
  requestAmbassadorWithdrawal,
  saveAmbassadorPayoutAccount,
  setupAmbassadorPin,
  submitAmbassadorApplication,
  verifyAmbassador,
} from '../controllers/ambassador.js';

const router = express.Router();

router.post('/apply', submitAmbassadorApplication);
router.post('/auth/setup-pin', setupAmbassadorPin);
router.post('/auth/signin', ambassadorSignIn);
router.get('/me', verifyAmbassador, getAmbassadorMe);
router.get('/overview', verifyAmbassador, getAmbassadorOverview);
router.get('/earnings', verifyAmbassador, getAmbassadorEarnings);
router.get('/badges', verifyAmbassador, getAmbassadorBadges);
router.get('/leaderboard', verifyAmbassador, getAmbassadorLeaderboard);
router.get('/resources', verifyAmbassador, getAmbassadorResources);
router.get('/payout-accounts', verifyAmbassador, getAmbassadorPayoutAccounts);
router.post('/payout-accounts', verifyAmbassador, saveAmbassadorPayoutAccount);
router.get('/withdrawals', verifyAmbassador, getAmbassadorWithdrawals);
router.post('/withdrawals', verifyAmbassador, requestAmbassadorWithdrawal);

export default router;
