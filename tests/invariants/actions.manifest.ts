// ORG-01..04 manifest (PRD 10 §1.5, D-317). Every 'use server' export, keyed
// `<path under apps/web>#<export>`, with the model each id it takes names.
//
// The foundation reads this off `ref()`-tagged zod schemas. These actions take
// `(…ids, previous, formData)` and parse by hand, so the tags live here
// instead. A key is a positional parameter (`leaseId`) or a form field
// (`form.vendorIds`); the value is the Prisma model it names, `<model>[]` for a
// list, `token` for a link secret, or `value` for an argument that is not an
// id. `=<text>` is a literal for a form field the action validates before its
// lookup, so the call reaches the lookup and the own-org sanity call can tell
// org A's ids from missing ones (R-286c). `public` marks an action a stranger
// may call, with the reason. `unreached` names an action the own-org sanity
// call cannot get past its row state, with what it would need: a stated gap,
// not a silent one.
//
// The harness fails on an export with no entry, an entry with no export, an
// untagged positional parameter, an id-like form field the action file reads
// that no entry in that file tags, and a model name the schema does not have.
// So a row that adds an action adds its line here or the suite is red.

export type Tag = string
export type Entry = Record<string, Tag> & { public?: string; unreached?: string }

export const manifest: Record<string, Entry> = {
  // lib/abandonment/actions.ts
  'lib/abandonment/actions.ts#openAbandonmentCase': { leaseId: 'lease' },
  'lib/abandonment/actions.ts#logContactAttempt': { 'form.caseId': 'abandonmentCase' },
  'lib/abandonment/actions.ts#recordEntry': { 'form.caseId': 'abandonmentCase' },
  'lib/abandonment/actions.ts#holdBelongings': { 'form.caseId': 'abandonmentCase' },
  'lib/abandonment/actions.ts#disposeBelongings': { 'form.caseId': 'abandonmentCase' },
  'lib/abandonment/actions.ts#closeAbandonmentCase': { 'form.caseId': 'abandonmentCase' },
  // lib/accommodations/actions.ts
  'lib/accommodations/actions.ts#receiveAccommodationRequest': { leaseId: 'lease', 'form.tenantId': 'tenant' },
  'lib/accommodations/actions.ts#requestDocumentation': { 'form.requestId': 'accommodationRequest' },
  'lib/accommodations/actions.ts#decideAccommodationRequest': { 'form.requestId': 'accommodationRequest' },
  // lib/applications/actions.ts
  'lib/applications/actions.ts#submitApplicantForm': { rawToken: 'token' },
  'lib/applications/actions.ts#inviteCoApplicant': { rawToken: 'token' },
  'lib/applications/actions.ts#uploadApplicationDocument': { rawToken: 'token' },
  'lib/applications/actions.ts#startApplicationFeePayment': { rawToken: 'token' },
  // lib/applications/staff-actions.ts
  'lib/applications/staff-actions.ts#inviteToApply': { prospectId: 'prospect' },
  'lib/applications/staff-actions.ts#addApplicantNote': { 'form.applicantId': 'applicant', 'form.body': '=Harness note' },
  // lib/auth/actions.ts
  'lib/auth/actions.ts#startStaffSignIn': { public: 'the staff sign-in form' },
  'lib/auth/actions.ts#completeStaffMfa': { public: 'second step of sign-in, gated by the pending-sign-in cookie' },
  'lib/auth/actions.ts#signOutEverywhere': {  },
  'lib/auth/actions.ts#beginMfaEnrolment': {  },
  'lib/auth/actions.ts#confirmMfaEnrolment': {  },
  'lib/auth/actions.ts#requestPasswordReset': { public: 'the forgot-password form; same answer whether or not the address exists' },
  'lib/auth/actions.ts#completePasswordReset': { public: 'gated by the reset token in the form' },
  'lib/auth/actions.ts#requestTenantMagicLink': { public: 'the tenant sign-in form; same answer whether or not the address is on a lease' },
  'lib/auth/actions.ts#requestGuarantorMagicLink': { public: 'the guarantor sign-in form; same answer whether or not the address is on a guarantee' },
  // lib/billing/actions.ts
  'lib/billing/actions.ts#resyncPayer': { 'form.leasePayerId': 'leasePayer' },
  'lib/billing/actions.ts#resyncLease': { 'form.leaseId': 'lease' },
  'lib/billing/actions.ts#setPaymentHold': { 'form.leasePayerId': 'leasePayer' },
  // lib/billing/recurring-actions.ts
  'lib/billing/recurring-actions.ts#addRecurringCharge': { leaseId: 'lease' },
  'lib/billing/recurring-actions.ts#endRecurringCharge': { 'form.recurringChargeId': 'recurringCharge' },
  // lib/billing/rubs-actions.ts
  'lib/billing/rubs-actions.ts#recordUtilityBill': { propertyId: 'property', 'form.documentId': 'document' },
  'lib/billing/rubs-actions.ts#splitUtilityBill': { 'form.utilityBillId': 'utilityBill' },
  // lib/calendar/actions.ts
  'lib/calendar/actions.ts#regenerateCalendarFeed': {  },
  // lib/comms/actions.ts
  'lib/comms/actions.ts#replyInThread': { threadId: 'thread' },
  'lib/comms/actions.ts#logCallInThread': { threadId: 'thread' },
  'lib/comms/actions.ts#fileUnroutedMessage': { unroutedId: 'unroutedMessage', 'form.tenantId': 'tenant' },
  // lib/comms/announcement-actions.ts
  'lib/comms/announcement-actions.ts#sendAnnouncement': { 'form.templateId': 'messageTemplate', 'form.leaseIds': 'lease[]', 'form.segment': '=ALL' },
  'lib/comms/announcement-actions.ts#saveAudience': {  },
  'lib/comms/announcement-actions.ts#cancelScheduledAnnouncement': { 'form.scheduleId': 'announcementSchedule' },
  'lib/comms/announcement-actions.ts#resendFailedAnnouncement': { unreached: 'needs a sent announcement whose audit row lists FAILED deliveries', 'form.auditLogId': 'auditLog' },
  'lib/comms/announcement-actions.ts#retireAudience': { 'form.audienceId': 'audience' },
  // lib/comms/messaging-settings-actions.ts
  'lib/comms/messaging-settings-actions.ts#saveMessagingSettings': { 'form.replyTaskAssigneeStaffId': 'staffUser' },
  'lib/comms/messaging-settings-actions.ts#saveQuietHours': { 'form.propertyId': 'property' },
  // lib/comms/template-actions.ts
  'lib/comms/template-actions.ts#saveTemplate': { templateId: 'messageTemplate', 'form.kind': '=ROUTINE', 'form.name': '=Harness template', 'form.body': '=Hello from the harness' },
  'lib/comms/template-actions.ts#restoreTemplateVersion': { templateId: 'messageTemplate', 'form.versionId': 'messageTemplateVersion' },
  'lib/comms/template-actions.ts#duplicateTemplate': { templateId: 'messageTemplate' },
  'lib/comms/template-actions.ts#retireTemplate': { templateId: 'messageTemplate' },
  'lib/comms/template-actions.ts#saveTranslation': { templateId: 'messageTemplate', 'form.locale': '=es', 'form.body': '=Hola desde el arnes' },
  'lib/comms/template-actions.ts#approveTranslation': { translationId: 'messageTemplateTranslation', 'form.reason': '=Reviewed by counsel on 14 Aug' },
  // lib/comms/transcript.ts
  'lib/comms/transcript.ts#exportThreadTranscript': { threadId: 'thread' },
  // lib/compliance/actions.ts
  'lib/compliance/actions.ts#createComplianceItem': { 'form.propertyId': 'property', 'form.legalEntityId': 'legalEntity', 'form.type': '=OTHER', 'form.label': '=Harness item', 'form.dueOn': '=2026-01-15' },
  'lib/compliance/actions.ts#recordCompletion': { itemId: 'complianceItem' },
  // lib/confidential/actions.ts
  'lib/confidential/actions.ts#openConfidentialCase': { 'form.leaseId': 'lease', 'form.restrictedPartyTenantId': 'tenant' },
  'lib/confidential/actions.ts#updateConfidentialCase': { caseId: 'confidentialCase', 'form.restrictedPartyTenantId': 'tenant' },
  'lib/confidential/actions.ts#orderLockChange': { caseId: 'confidentialCase' },
  'lib/confidential/actions.ts#closeConfidentialCase': { caseId: 'confidentialCase' },
  'lib/confidential/actions.ts#recordEarlyTermination': { caseId: 'confidentialCase' },
  'lib/confidential/actions.ts#startConfidentialBifurcation': { caseId: 'confidentialCase' },
  // lib/consent/actions.ts
  'lib/consent/actions.ts#recordConsent': {  },
  'lib/consent/actions.ts#withdrawConsent': { 'form.consentId': 'tenantConsent' },
  'lib/consent/actions.ts#withdrawOwnConsent': { 'form.consentId': 'tenantConsent' },
  // lib/deposits/actions.ts
  'lib/deposits/actions.ts#addDeduction': { depositId: 'deposit', 'form.workOrderId': 'workOrder', 'form.inspectionItemId': 'inspectionItem' },
  'lib/deposits/actions.ts#removeDeduction': { deductionId: 'depositDeduction' },
  'lib/deposits/actions.ts#finalizeDisposition': { depositId: 'deposit' },
  'lib/deposits/actions.ts#recordDepositRefund': { depositId: 'deposit' },
  // lib/deposits/packet.ts
  'lib/deposits/packet.ts#exportDepositPacket': { leaseId: 'lease' },
  // lib/documents/actions.ts
  'lib/documents/actions.ts#uploadDocument': { propertyId: 'property', unitId: 'unit' },
  'lib/documents/actions.ts#deleteDocument': { documentId: 'document' },
  'lib/documents/actions.ts#restoreDocument': { documentId: 'document' },
  // lib/documents/generate.ts
  'lib/documents/generate.ts#generateDocumentFromTemplate': { templateId: 'documentTemplate', 'form.propertyId': 'property', 'form.recipientName': '=Harness Recipient' },
  // lib/documents/template-actions.ts
  'lib/documents/template-actions.ts#saveDocumentTemplate': { templateId: 'documentTemplate', 'form.name': '=Harness doc template', 'form.documentType': '=NOTICE', 'form.body': '=Hello from the harness' },
  'lib/documents/template-actions.ts#retireDocumentTemplate': { templateId: 'documentTemplate' },
  // lib/evictions/actions.ts
  'lib/evictions/actions.ts#openEvictionCase': { 'form.leaseId': 'lease' },
  'lib/evictions/actions.ts#attachNoticeToCase': { caseId: 'evictionCase', 'form.noticeId': 'notice' },
  'lib/evictions/actions.ts#draftCureNotice': { caseId: 'evictionCase' },
  'lib/evictions/actions.ts#advanceEvictionStage': { caseId: 'evictionCase', 'form.stage': '=CLOSED', 'form.outcome': '=WITHDRAWN', 'form.outcomeNote': '=Withdrawn by the harness' },
  'lib/evictions/actions.ts#recordEvictionCost': { caseId: 'evictionCase' },
  // lib/evictions/packet.ts
  'lib/evictions/packet.ts#exportAttorneyPacket': { caseId: 'evictionCase' },
  // lib/filing-cabinet/actions.ts
  'lib/filing-cabinet/actions.ts#setCostBasis': { propertyId: 'property' },
  'lib/filing-cabinet/actions.ts#addMortgage': { propertyId: 'property' },
  'lib/filing-cabinet/actions.ts#deleteMortgage': { propertyId: 'property', mortgageId: 'mortgage' },
  'lib/filing-cabinet/actions.ts#addInsurancePolicy': { propertyId: 'property' },
  'lib/filing-cabinet/actions.ts#deleteInsurancePolicy': { propertyId: 'property', insurancePolicyId: 'insurancePolicy' },
  'lib/filing-cabinet/actions.ts#setHoaInfo': { propertyId: 'property' },
  'lib/filing-cabinet/actions.ts#addWarranty': { propertyId: 'property' },
  'lib/filing-cabinet/actions.ts#deleteWarranty': { propertyId: 'property', warrantyId: 'warranty' },
  'lib/filing-cabinet/actions.ts#addCapitalImprovement': { propertyId: 'property', 'form.workOrderId': 'workOrder' },
  'lib/filing-cabinet/actions.ts#deleteCapitalImprovement': { propertyId: 'property', capitalImprovementId: 'capitalImprovement' },
  'lib/filing-cabinet/actions.ts#recordMortgageStatement': { propertyId: 'property', mortgageId: 'mortgage' },
  'lib/filing-cabinet/actions.ts#deleteMortgageStatement': { propertyId: 'property', statementId: 'mortgageAnnualStatement' },
  // lib/holds/actions.ts
  'lib/holds/actions.ts#placeLeaseHold': { 'form.leaseId': 'lease', 'form.type': '=dispute', 'form.reason': '=Harness hold' },
  'lib/holds/actions.ts#liftLeaseHold': { 'form.holdId': 'leaseHold', 'form.liftReason': '=Harness lift' },
  // lib/import/actions.ts
  'lib/import/actions.ts#runImport': {  },
  // lib/import/documents.ts
  'lib/import/documents.ts#bulkUploadDocuments': {  },
  // lib/inspections/actions.ts
  'lib/inspections/actions.ts#startInspection': { 'form.unitId': 'unit', 'form.templateId': 'inspectionTemplate', 'form.type': '=PERIODIC' },
  'lib/inspections/actions.ts#recordItem': { itemId: 'inspectionItem' },
  'lib/inspections/actions.ts#recordItemPhoto': { itemId: 'inspectionItem' },
  'lib/inspections/actions.ts#finishInspection': { inspectionId: 'inspection' },
  'lib/inspections/actions.ts#recordSignature': { inspectionId: 'inspection' },
  'lib/inspections/actions.ts#lockInspection': { inspectionId: 'inspection' },
  // lib/inspections/scheduling.ts
  'lib/inspections/scheduling.ts#scheduleInspectionEntry': { inspectionId: 'inspection' },
  // lib/inspections/template-actions.ts
  'lib/inspections/template-actions.ts#saveInspectionTemplate': { templateId: 'inspectionTemplate', 'form.name': '=Harness checklist', 'form.room': '=Kitchen', 'form.item': '=Sink' },
  'lib/inspections/template-actions.ts#retireInspectionTemplate': { templateId: 'inspectionTemplate' },
  // lib/insurance/actions.ts
  'lib/insurance/actions.ts#openClaim': { propertyId: 'property', 'form.policyId': 'insurancePolicy' },
  'lib/insurance/actions.ts#updateClaimDetails': { 'form.claimId': 'insuranceClaim' },
  'lib/insurance/actions.ts#linkWorkOrder': { 'form.claimId': 'insuranceClaim', 'form.workOrderId': 'workOrder' },
  'lib/insurance/actions.ts#unlinkWorkOrder': { 'form.claimId': 'insuranceClaim', 'form.workOrderId': 'workOrder' },
  'lib/insurance/actions.ts#recordClaimPayment': { 'form.claimId': 'insuranceClaim' },
  'lib/insurance/actions.ts#logClaimEvent': { 'form.claimId': 'insuranceClaim' },
  'lib/insurance/actions.ts#uploadLossPhoto': { 'form.claimId': 'insuranceClaim' },
  'lib/insurance/actions.ts#recordLossOfRents': { 'form.claimId': 'insuranceClaim', 'form.unitId': 'unit' },
  'lib/insurance/actions.ts#closeClaim': { 'form.claimId': 'insuranceClaim' },
  // lib/jobs/actions.ts
  'lib/jobs/actions.ts#rerunJobAction': { 'form.jobRunId': 'jobRun' },
  // lib/jurisdiction/actions.ts
  'lib/jurisdiction/actions.ts#createRuleVersion': {  },
  // lib/leases/access-code-actions.ts
  'lib/leases/access-code-actions.ts#issueAccessCodeToTenant': { leaseId: 'lease', accessCodeId: 'accessCode' },
  'lib/leases/access-code-actions.ts#issueTenantLockCode': { leaseId: 'lease', tenantId: 'tenant' },
  'lib/leases/access-code-actions.ts#revokeTenantLockCode': { leaseId: 'lease', tenantId: 'tenant' },
  // lib/leases/actions.ts
  'lib/leases/actions.ts#createLease': { 'form.unitId': 'unit' },
  'lib/leases/actions.ts#updateLeaseTerms': { leaseId: 'lease' },
  'lib/leases/actions.ts#cancelRentChange': { leaseId: 'lease' },
  'lib/leases/actions.ts#changeLeaseStatus': { leaseId: 'lease', to: 'value' },
  'lib/leases/actions.ts#recordLeaseNotice': { leaseId: 'lease' },
  'lib/leases/actions.ts#addLeaseTenant': { leaseId: 'lease', 'form.tenantId': 'tenant' },
  'lib/leases/actions.ts#removeLeaseTenant': { leaseId: 'lease', 'form.leaseTenantId': 'leaseTenant' },
  'lib/leases/actions.ts#addGuarantor': { leaseId: 'lease' },
  'lib/leases/actions.ts#resolveIntakeItem': { leaseId: 'lease' },
  // lib/leases/condition-baseline-actions.ts
  'lib/leases/condition-baseline-actions.ts#uploadConditionBaseline': { leaseId: 'lease' },
  // lib/leases/esign-actions.ts
  'lib/leases/esign-actions.ts#signLeaseDocument': { token: 'token' },
  // lib/leases/esign-staff-actions.ts
  'lib/leases/esign-staff-actions.ts#generateAndSendLease': { leaseId: 'lease' },
  'lib/leases/esign-staff-actions.ts#voidEnvelope': { leaseId: 'lease' },
  // lib/leases/insurance-actions.ts
  'lib/leases/insurance-actions.ts#recordRenterInsurance': { leaseId: 'lease' },
  // lib/leases/party-change-actions.ts
  'lib/leases/party-change-actions.ts#startPartyChange': { leaseId: 'lease', 'form.outgoingLeaseTenantId': 'leaseTenant[]', 'form.incomingApplicantId': 'applicant[]' },
  'lib/leases/party-change-actions.ts#releaseGuarantor': { leaseId: 'lease', guarantorId: 'guarantor' },
  'lib/leases/party-change-actions.ts#voidPartyChange': { leaseId: 'lease', 'form.changeId': 'leasePartyChange' },
  // lib/leases/renewal-actions.ts
  'lib/leases/renewal-actions.ts#offerRenewal': { leaseId: 'lease' },
  // lib/ledger/statement.ts
  'lib/ledger/statement.ts#exportLedgerStatement': { leaseId: 'lease' },
  // lib/ledger/waivers.ts
  'lib/ledger/waivers.ts#waiveCharge': { 'form.chargeId': 'charge' },
  // lib/listings/actions.ts
  'lib/listings/actions.ts#createListing': { unitId: 'unit' },
  'lib/listings/actions.ts#updateListing': { listingId: 'listing' },
  'lib/listings/actions.ts#publishListing': { listingId: 'listing' },
  'lib/listings/actions.ts#unpublishListing': { listingId: 'listing' },
  // lib/listings/syndication.ts
  'lib/listings/syndication.ts#syndicateListing': { listingId: 'listing' },
  // lib/maintenance/actions.ts
  'lib/maintenance/actions.ts#uploadMaintenancePhoto': { file: 'value' },
  'lib/maintenance/actions.ts#attachMaintenancePhoto': { ticketId: 'ticket', documentId: 'document' },
  'lib/maintenance/actions.ts#submitMaintenanceRequest': { args: 'value' },
  'lib/maintenance/actions.ts#submitMaintenanceRequestForm': {  },
  'lib/maintenance/actions.ts#submitEmergencyForm': {  },
  'lib/maintenance/actions.ts#submitEmergencyRequest': { args: 'value' },
  'lib/maintenance/actions.ts#logPhoneMaintenanceRequest': { 'form.leaseTenantId': 'leaseTenant' },
  'lib/maintenance/actions.ts#setTicketPriority': { taskId: 'task' },
  'lib/maintenance/actions.ts#markTicketEmergency': { 'form.ticketId': 'ticket' },
  'lib/maintenance/actions.ts#resolveTicketTriage': { taskId: 'task', resolution: 'value' },
  'lib/maintenance/actions.ts#mergeTicketDuplicate': { taskId: 'task', 'form.targetTicketId': 'ticket' },
  'lib/maintenance/actions.ts#acknowledgeEmergency': { 'form.ticketId': 'ticket' },
  'lib/maintenance/actions.ts#setVendorEmergencyAvailability': { 'form.vendorId': 'vendor' },
  // lib/maintenance/clarify-actions.ts
  'lib/maintenance/clarify-actions.ts#submitClarification': { token: 'token', args: 'value' },
  'lib/maintenance/clarify-actions.ts#submitClarificationForm': { token: 'token' },
  'lib/maintenance/clarify-actions.ts#uploadClarificationPhoto': { token: 'token', file: 'value' },
  // lib/maintenance/preventive-actions.ts
  'lib/maintenance/preventive-actions.ts#savePreventiveTemplate': { templateId: 'preventiveMaintenanceTemplate', 'form.name': '=Harness task', 'form.intervalMonths': '=6' },
  'lib/maintenance/preventive-actions.ts#deactivatePreventiveTemplate': { templateId: 'preventiveMaintenanceTemplate' },
  'lib/maintenance/preventive-actions.ts#runPreventiveBatch': { templateId: 'preventiveMaintenanceTemplate' },
  // lib/notices/actions.ts
  'lib/notices/actions.ts#generateNoticePdf': { noticeId: 'notice' },
  'lib/notices/actions.ts#generateNoticePdfAction': { noticeId: 'notice' },
  'lib/notices/actions.ts#recordNoticeService': { noticeId: 'notice' },
  // lib/notifications/actions.ts
  'lib/notifications/actions.ts#setNotificationPreference': {  },
  'lib/notifications/actions.ts#setOwnNotificationPreference': {  },
  'lib/notifications/actions.ts#setOwnGuarantorNotificationPreference': {  },
  'lib/notifications/actions.ts#setTenantNotificationPreference': { tenantId: 'tenant' },
  // lib/oncall/actions.ts
  'lib/oncall/actions.ts#setOnCall': {  },
  // lib/operational/actions.ts
  'lib/operational/actions.ts#addAccessCode': { unitId: 'unit' },
  'lib/operational/actions.ts#revealAccessCode': { unitId: 'unit', accessCodeId: 'accessCode', workOrderId: 'workOrder' },
  'lib/operational/actions.ts#addAppliance': { unitId: 'unit' },
  'lib/operational/actions.ts#deleteAppliance': { unitId: 'unit', applianceId: 'appliance' },
  'lib/operational/actions.ts#addUtilityAccount': { unitId: 'unit' },
  'lib/operational/actions.ts#deleteUtilityAccount': { unitId: 'unit', utilityAccountId: 'utilityAccount' },
  'lib/operational/actions.ts#setShutoffLocation': { unitId: 'unit' },
  // lib/payments/actions.ts
  'lib/payments/actions.ts#startPayment': {  },
  'lib/payments/actions.ts#startPaymentFromLink': { token: 'token' },
  // lib/payments/autopay-actions.ts
  'lib/payments/autopay-actions.ts#startAutopaySetup': {  },
  'lib/payments/autopay-actions.ts#setDebitDay': {  },
  'lib/payments/autopay-actions.ts#turnOffAutopay': {  },
  // lib/payments/collection.ts
  'lib/payments/collection.ts#switchCollectionMethod': { 'form.leasePayerId': 'leasePayer', 'form.collectionMethod': '=send_invoice', 'form.reason': '=Harness switch' },
  // lib/payments/deposit-actions.ts
  'lib/payments/deposit-actions.ts#createDepositBatch': { 'form.paymentId': 'payment[]' },
  // lib/payments/offline.ts
  'lib/payments/offline.ts#recordOfflinePayment': { leasePayerId: 'leasePayer' },
  // lib/payments/plan-actions.ts
  'lib/payments/plan-actions.ts#agreePaymentPlan': { 'form.leaseId': 'lease', 'form.note': '=Harness plan', 'form.totalDollars': '=300', 'form.instalments': '=3', 'form.firstDueOn': '=2026-11-01' },
  'lib/payments/plan-actions.ts#sendPaymentPlanForSignature': { 'form.planId': 'paymentPlan', 'form.leaseId': 'value' }, // leaseId only names the page to revalidate
  'lib/payments/plan-actions.ts#cancelPaymentPlan': { 'form.planId': 'paymentPlan', 'form.cancelReason': '=Harness cancel' },
  // lib/payments/reminders.ts
  'lib/payments/reminders.ts#sendReminders': { 'form.templateId': 'messageTemplate', 'form.leaseIds': 'lease[]' },
  // lib/payments/write-off-actions.ts
  'lib/payments/write-off-actions.ts#writeOffReceivable': { leaseId: 'lease' },
  // lib/portal/actions.ts
  'lib/portal/actions.ts#signOutTenant': {  },
  'lib/portal/actions.ts#signOutGuarantor': {  },
  'lib/portal/actions.ts#replyFromPortal': { threadId: 'thread' },
  // lib/portal/inspection-actions.ts
  'lib/portal/inspection-actions.ts#signInspectionAsTenant': { inspectionId: 'inspection' },
  'lib/portal/inspection-actions.ts#recordItemAsTenant': { itemId: 'inspectionItem' },
  'lib/portal/inspection-actions.ts#recordItemPhotoAsTenant': { itemId: 'inspectionItem' },
  'lib/portal/inspection-actions.ts#finishInspectionAsTenant': { inspectionId: 'inspection' },
  // lib/portal/notice-to-vacate-actions.ts
  'lib/portal/notice-to-vacate-actions.ts#submitNoticeToVacate': {  },
  // lib/portal/verify-actions.ts
  'lib/portal/verify-actions.ts#verifyWorkOrder': { 'form.workOrderId': 'workOrder', 'form.resolved': '=yes' },
  // lib/portal/verify-link-actions.ts
  'lib/portal/verify-link-actions.ts#answerFromLink': { token: 'token' },
  // lib/properties/actions.ts
  'lib/properties/actions.ts#createLegalEntity': {  },
  'lib/properties/actions.ts#updateLegalEntity': { entityId: 'legalEntity', 'form.legalEntityId': 'legalEntity' },
  'lib/properties/actions.ts#createProperty': {  },
  'lib/properties/actions.ts#updateProperty': { propertyId: 'property' },
  // lib/properties/handoff-actions.ts
  'lib/properties/handoff-actions.ts#generateEstoppelCertificates': { propertyId: 'property' },
  'lib/properties/handoff-actions.ts#archiveHandoffPacket': { propertyId: 'property' },
  // lib/property-expenses/actions.ts
  'lib/property-expenses/actions.ts#recordPropertyExpense': { 'form.propertyId': 'property', 'form.legalEntityId': 'legalEntity', 'form.category': '=ADVERTISING', 'form.amountDollars': '=100', 'form.paidOn': '=2026-01-15', 'form.description': '=Harness expense' },
  'lib/property-expenses/actions.ts#stopExpenseRecurrence': { expenseId: 'propertyExpense' },
  // lib/prospects/actions.ts
  'lib/prospects/actions.ts#submitInquiry': { listingId: 'listing', public: 'the public listing page inquiry form' },
  // lib/prospects/prescreen-actions.ts
  'lib/prospects/prescreen-actions.ts#submitPrescreenAnswers': { rawToken: 'token' },
  // lib/prospects/staff-actions.ts
  'lib/prospects/staff-actions.ts#advanceProspectStage': { prospectId: 'prospect' },
  // lib/reports/settlement-actions.ts
  'lib/reports/settlement-actions.ts#recordSettlementTransfer': {  },
  // lib/reserves/actions.ts
  'lib/reserves/actions.ts#setPropertyReserve': { propertyId: 'property' },
  // lib/scope/actions.ts
  'lib/scope/actions.ts#selectScope': {  },
  // lib/scra/actions.ts
  'lib/scra/actions.ts#recordScraLookup': { leaseId: 'lease', 'form.tenantId': 'tenant', 'form.evictionCaseId': 'evictionCase' },
  'lib/scra/actions.ts#recordScraTermination': { leaseId: 'lease' },
  // lib/screening/criteria-actions.ts
  'lib/screening/criteria-actions.ts#createCriteriaVersion': {  },
  // lib/screening/staff-actions.ts
  'lib/screening/staff-actions.ts#recordScreeningDecision': { 'form.applicantId': 'applicant', 'form.decision': '=APPROVED' },
  'lib/screening/staff-actions.ts#requestApplicantInfo': { 'form.applicantId': 'applicant', 'form.request': '=Please send proof of income' },
  // lib/showings/access-actions.ts
  'lib/showings/access-actions.ts#verifyIdentityForShowing': { rawToken: 'token' },
  // lib/showings/actions.ts
  'lib/showings/actions.ts#bookShowing': { rawToken: 'token' },
  // lib/showings/staff-actions.ts
  'lib/showings/staff-actions.ts#cancelShowing': { showingId: 'showing' },
  'lib/showings/staff-actions.ts#revokeShowingAccess': { showingId: 'showing' },
  'lib/showings/staff-actions.ts#syncLockEvents': { unitId: 'unit' },
  // lib/staff/actions.ts
  'lib/staff/actions.ts#inviteStaff': {  },
  'lib/staff/actions.ts#manageStaff': { staffUserId: 'staffUser', 'form.assignmentId': 'staffAssignment' },
  // lib/tasks/actions.ts
  'lib/tasks/actions.ts#addTask': { 'form.propertyId': 'property' },
  'lib/tasks/actions.ts#claimTask': { taskId: 'task' },
  'lib/tasks/actions.ts#completeTask': { taskId: 'task' },
  'lib/tasks/actions.ts#cancelTask': { taskId: 'task' },
  // lib/tax/archive.ts
  'lib/tax/archive.ts#archiveTaxPacket': {  },
  // lib/turnover/actions.ts
  'lib/turnover/actions.ts#setTurnoverTargetDate': { projectId: 'turnoverProject' },
  'lib/turnover/actions.ts#markTurnoverRentReady': { projectId: 'turnoverProject' },
  // lib/units/actions.ts
  'lib/units/actions.ts#createUnit': { propertyId: 'property' },
  'lib/units/actions.ts#updateUnit': { propertyId: 'property', unitId: 'unit' },
  // lib/vendor-invoices/actions.ts
  'lib/vendor-invoices/actions.ts#recordVendorInvoice': { 'form.legalEntityId': 'legalEntity', 'form.vendorId': 'vendor', 'form.totalDollars': '=100', 'form.invoicedOn': '=2026-01-15', 'form.splits.0.category': '=REPAIRS', 'form.splits.0.amountDollars': '=100', 'form.splits.0.propertyId': 'property' },
  // lib/vendors/actions.ts
  'lib/vendors/actions.ts#respondToWorkOrder': { token: 'token' },
  'lib/vendors/actions.ts#revealCodeForVendor': { token: 'token', 'form.accessCodeId': 'accessCode' },
  'lib/vendors/actions.ts#uploadVendorDocument': { token: 'token' },
  'lib/vendors/actions.ts#markWorkComplete': { token: 'token' },
  'lib/vendors/actions.ts#sendVendorMessage': { token: 'token' },
  // lib/vendors/bid-actions.ts
  'lib/vendors/bid-actions.ts#submitBid': { token: 'token' },
  // lib/vendors/staff-actions.ts
  'lib/vendors/staff-actions.ts#saveVendorRecord': { vendorId: 'vendor', 'form.name': '=Harness vendor', 'form.trades': '=plumbing' },
  'lib/vendors/staff-actions.ts#deactivateVendor': { vendorId: 'vendor' },
  'lib/vendors/staff-actions.ts#markInvoicePaid': { workOrderId: 'workOrder', 'form.invoicePaymentMethod': '=CHECK' },
  // lib/violations/actions.ts
  'lib/violations/actions.ts#openViolationCase': { leaseId: 'lease' },
  'lib/violations/actions.ts#recordObservation': { 'form.caseId': 'violationCase' },
  'lib/violations/actions.ts#linkAccommodationRequest': { 'form.caseId': 'violationCase', 'form.requestId': 'accommodationRequest' },
  'lib/violations/actions.ts#closeViolationCase': { 'form.caseId': 'violationCase', 'form.legitimizedApplicantId': 'applicant' },
  // lib/workorders/actions.ts
  'lib/workorders/actions.ts#createWorkOrder': { 'form.ticketId': 'ticket', 'form.unitId': 'unit', 'form.turnoverProjectId': 'turnoverProject' },
  'lib/workorders/actions.ts#assignWorkOrder': { workOrderId: 'workOrder', 'form.assignedStaffId': 'staffUser', 'form.vendorId': 'vendor' },
  'lib/workorders/actions.ts#setWorkOrderWarrantyHold': { workOrderId: 'workOrder', onHold: 'value' },
  'lib/workorders/actions.ts#dispatchToVendor': { workOrderId: 'workOrder' },
  'lib/workorders/actions.ts#markWorkComplete': { workOrderId: 'workOrder' },
  'lib/workorders/actions.ts#closeWorkOrder': { workOrderId: 'workOrder' },
  'lib/workorders/actions.ts#addWorkOrderNote': { workOrderId: 'workOrder' },
  'lib/workorders/actions.ts#replyToTenantFromWorkOrder': { workOrderId: 'workOrder' },
  'lib/workorders/actions.ts#replyToVendorFromWorkOrder': { workOrderId: 'workOrder' },
  'lib/workorders/actions.ts#attachMessageToWorkOrder': { workOrderId: 'workOrder', 'form.messageId': 'message' },
  // lib/workorders/approvals.ts
  'lib/workorders/approvals.ts#submitForApproval': { workOrderId: 'workOrder' },
  'lib/workorders/approvals.ts#decideApproval': { workOrderId: 'workOrder' },
  'lib/workorders/approvals.ts#recordActuals': { workOrderId: 'workOrder' },
  'lib/workorders/approvals.ts#requestBids': { workOrderId: 'workOrder', 'form.vendorIds': 'vendor[]' },
  // lib/workorders/chargeback-actions.ts
  'lib/workorders/chargeback-actions.ts#postChargeback': { workOrderId: 'workOrder' },
  // lib/workorders/scheduling.ts
  'lib/workorders/scheduling.ts#scheduleEntry': { workOrderId: 'workOrder' },
  'lib/workorders/scheduling.ts#logEntryPermission': { workOrderId: 'workOrder' },
  'lib/workorders/scheduling.ts#logTenantNoShow': { workOrderId: 'workOrder' },
}
