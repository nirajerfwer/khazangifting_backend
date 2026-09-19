// No email provider is configured in this project yet (no SMTP/SES/Resend credentials
// found in the env). This stub logs instead of sending so the reset flow is complete and
// testable end-to-end; swap the body for a real provider call before shipping to production.
export const sendPasswordResetEmail = async (email: string, resetToken: string) => {
  const resetUrl = `${process.env.FRONTEND}/reset-password?token=${resetToken}`;
  console.log(`[mailer] Password reset requested for ${email}. Link: ${resetUrl}`);
};
