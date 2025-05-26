// src/routes/userRoutes.js
const express = require('express');
const UserController = require('../controllers/userController');

const router = express.Router();
const userController = new UserController();

router.post('/signup', userController.signUp);
router.post('/signin', userController.signIn);
router.get('/user', userController.getUserData);
router.post('/forgot-password', userController.forgotPassword);
router.post('/signout', userController.signOut);
// Uncomment the line below when you implement sign-in with OAuth providers
// router.post('/signin-with-provider', userController.signInWithProvider.bind(userController));
// router.post('/signin-with-google', userController.signInWithGoogle.bind(userController));