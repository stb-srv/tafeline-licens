import express from 'express';
import crudRoutes from './invoices/crud.js';
import deliveryRoutes from './invoices/delivery.js';
import settingsRoutes from './invoices/settings.js';

// Rechnungen im Admin-Bereich – aufgeteilt nach Domäne
const router = express.Router();
router.use(crudRoutes);
router.use(deliveryRoutes);
router.use(settingsRoutes);

export default router;
