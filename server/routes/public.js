import { Router } from 'express';
import setupRoutes from './public/setup.js';
import validationRoutes from './public/validation.js';
import infoRoutes from './public/info.js';

// Öffentliche API (/api/v1) – aufgeteilt nach Domäne
const router = Router();
router.use(setupRoutes);
router.use(validationRoutes);
router.use(infoRoutes);

export default router;
