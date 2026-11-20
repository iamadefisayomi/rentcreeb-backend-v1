import { createHash } from 'crypto';

/**
 * Standard residential tenancy agreement used by Digital Tenancy Agreements. The landlord can edit any clause or add
 * their own before sending. It is a starting point, not legal advice: the app says so and suggests a lawyer's review
 * for unusual arrangements.
 */
export type LeaseFields = {
  landlordName: string; tenantName: string; propertyAddress: string; unitLabel?: string | null;
  rentNaira: string; frequency: 'monthly' | 'quarterly' | 'yearly'; startDate: string; endDate?: string | null;
  cautionNaira?: string | null; serviceChargeNaira?: string | null; noticeDays?: number; state?: string | null;
};
export type Clause = { heading: string; body: string };

const fmtDate = (d?: string | null) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' }) : 'the end of the agreed term');
const per = { monthly: 'per month', quarterly: 'per quarter (every 3 months)', yearly: 'per year' } as const;

export function defaultClauses(f: LeaseFields): Clause[] {
  const premises = `${f.unitLabel ? `${f.unitLabel}, ` : ''}${f.propertyAddress}`;
  const notice = f.noticeDays ?? (f.frequency === 'monthly' ? 30 : f.frequency === 'quarterly' ? 90 : 180);
  const state = f.state || 'Lagos';
  return [
    { heading: 'Parties', body: `This agreement is made between ${f.landlordName} ("the Landlord") and ${f.tenantName} ("the Tenant").` },
    { heading: 'Premises', body: `The Landlord lets to the Tenant the residential premises at ${premises} ("the Premises"), together with the fixtures and fittings listed in the move-in condition report.` },
    { heading: 'Term', body: `The tenancy begins on ${fmtDate(f.startDate)} and ends on ${fmtDate(f.endDate)}, unless renewed or ended earlier under this agreement.` },
    { heading: 'Rent', body: `The rent is ₦${f.rentNaira} ${per[f.frequency]}, payable in advance on or before each due date through the RentCreeb app or as otherwise agreed in writing. RentCreeb issues a receipt for every payment. Any approved instalment plan agreed in the app forms part of this agreement.` },
    ...(f.cautionNaira ? [{ heading: 'Caution deposit', body: `The Tenant pays a refundable caution deposit of ₦${f.cautionNaira}. It is returned within 30 days after the tenancy ends, less the reasonable cost of repairing damage beyond fair wear and tear, as shown by comparing the move-in and move-out condition reports. Any deduction is explained in writing.` }] : []),
    ...(f.serviceChargeNaira ? [{ heading: 'Service charge', body: `The Tenant contributes ₦${f.serviceChargeNaira} towards shared services (security, cleaning, waste, shared power and water), billed through the app with a breakdown.` }] : []),
    { heading: 'Use of the premises', body: 'The Tenant will use the Premises as a private residence only, keep it clean and in good condition, and not cause a nuisance to neighbours. No illegal activity is permitted.' },
    { heading: "Tenant's obligations", body: 'The Tenant will pay rent and agreed bills on time, report repairs promptly through the app, allow the Landlord reasonable access for inspection or repairs after at least 24 hours\' notice (except in an emergency), and not make structural changes without written consent.' },
    { heading: "Landlord's obligations", body: 'The Landlord will allow the Tenant quiet enjoyment of the Premises, keep the structure, roof, plumbing and electrical installations in good repair, and carry out repairs within a reasonable time after they are reported.' },
    { heading: 'Repairs', body: 'Repairs are requested and tracked in the RentCreeb app. Damage caused by the Tenant, their household or visitors beyond fair wear and tear is repaired at the Tenant\'s cost.' },
    { heading: 'Subletting', body: 'The Tenant may not sublet, assign or part with possession of the Premises without the Landlord\'s written consent.' },
    { heading: 'Ending the tenancy', body: `Either party may end the tenancy at the end of the term by giving at least ${notice} days' written notice (notice given in the app counts as written notice), subject to any longer notice required by the law of ${state} State. The Tenant will leave the Premises in the condition recorded at move-in, fair wear and tear excepted.` },
    { heading: 'Renewal', body: 'The tenancy may be renewed on terms both parties accept in the app. Until a renewal is accepted, the terms of this agreement continue to apply for any period the Tenant remains with the Landlord\'s consent.' },
    { heading: 'Governing law', body: `This agreement is governed by the laws of ${state} State and the Federal Republic of Nigeria. Nothing in it removes any right the Tenant or Landlord has under those laws.` },
    { heading: 'Electronic signatures', body: 'Both parties agree to sign electronically in the RentCreeb app. An electronic signature recorded with the date, time and a fingerprint of the agreement\'s contents is as binding as a handwritten one.' },
  ];
}

/** Fingerprint of exactly what was signed (fields + clauses), stored with each signature. */
export function contentHash(fields: unknown, clauses: Clause[]) {
  return createHash('sha256').update(JSON.stringify({ fields, clauses })).digest('hex');
}
