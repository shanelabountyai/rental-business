// How many SMS segments a body costs (R-260, PRD 08 A1).
//
// GSM-7 carries 160 characters in one segment and 153 per segment once it
// splits (a 7-byte header rides in each). One character outside GSM-7 - a
// curly quote, an emoji - flips the WHOLE message to UCS-2: 70 / 67. That
// flip is the surprise worth showing before send, so it is reported.

export const SMS_MAX_LENGTH = 1600
/// Pass-through estimate, PRD 08 §pricing (~$0.01 a segment). An estimate, not
/// the carrier's invoice.
export const SMS_SEGMENT_COST_CENTS = 1

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
/// Each of these is sent as an escape plus a character: two septets.
const GSM_EXTENDED = '^{}\\[~]|€\f'

export interface SmsLength {
  encoding: 'GSM-7' | 'UCS-2'
  /// Characters the carrier counts (septets for GSM-7, UTF-16 units for UCS-2).
  units: number
  segments: number
}

export function smsLength(body: string): SmsLength {
  let septets = 0
  let gsm = true
  for (const char of body) {
    if (GSM_BASIC.includes(char)) septets += 1
    else if (GSM_EXTENDED.includes(char)) septets += 2
    else {
      gsm = false
      break
    }
  }
  if (gsm) {
    return {
      encoding: 'GSM-7',
      units: septets,
      segments: septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153),
    }
  }
  const units = body.length
  return { encoding: 'UCS-2', units, segments: units <= 70 ? 1 : Math.ceil(units / 67) }
}
