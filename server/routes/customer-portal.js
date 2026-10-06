import { Router } from 'express';
import authRoutes from './portal/auth.js';
import licenseRoutes from './portal/licenses.js';
import invoiceRoutes from './portal/invoices.js';

// Kunden-Portal (/api/portal) – aufgeteilt nach Domäne
const router = Router();
router.use(authRoutes);
router.use(licenseRoutes);
router.use(invoiceRoutes);

export default router;
