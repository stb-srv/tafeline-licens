export function toDbDate(d) {
    return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
}
