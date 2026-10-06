export function up(db) {
    db.exec(`
        ALTER TABLE invoice_settings ADD COLUMN grace_period_days INTEGER NOT NULL DEFAULT 7;
        ALTER TABLE licenses ADD COLUMN grace_period_days INTEGER;
    `);
}

export default up;
