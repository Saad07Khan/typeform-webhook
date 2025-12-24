import { createClient } from '@supabase/supabase-js';

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Verify Typeform signature (if configured)
    if (process.env.TYPEFORM_WEBHOOK_SECRET) {
      const signature = req.headers['typeform-signature'];
      if (!signature || !verifyTypeformSignature(req.body, signature)) {
        console.error('Invalid Typeform signature');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const payload = req.body;
    
    // Check payload size (Vercel limit is 4.5MB on Hobby tier)
    const payloadSize = JSON.stringify(payload).length;
    if (payloadSize > 4 * 1024 * 1024) { // 4MB safety margin
      console.error(`Payload too large: ${payloadSize} bytes`);
      return res.status(413).json({ error: 'Payload too large' });
    }
    
    // Validate payload structure
    if (!payload || !payload.form_response) {
      console.error('Invalid payload structure:', payload);
      return res.status(400).json({ error: 'Invalid payload structure' });
    }
    
    // Extract form data
    const formResponse = payload.form_response;
    
    if (!formResponse.token || !formResponse.form_id) {
      console.error('Missing required fields:', formResponse);
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const submissionId = formResponse.token;
    const formId = formResponse.form_id;
    const submittedAt = formResponse.submitted_at || new Date().toISOString();

    console.log(`Processing submission: ${submissionId}`);

    // STEP 1: Save to Supabase (critical - must succeed)
    let dbSubmissionId;
    try {
      dbSubmissionId = await saveToSupabase(formResponse);
    } catch (supabaseError) {
      console.error('Supabase save failed:', supabaseError);
      // Return 500 so Typeform retries
      return res.status(500).json({ 
        error: 'Database save failed',
        message: supabaseError.message 
      });
    }

    // STEP 2: Update Airtable (best effort)
    try {
      await updateAirtable(formResponse, dbSubmissionId);
    } catch (airtableError) {
      console.error('Airtable update failed:', airtableError);
      // Don't fail the webhook - Airtable is nice-to-have
    }

    return res.status(200).json({ 
      success: true, 
      submission_id: submissionId 
    });

  } catch (error) {
    console.error('Error processing webhook:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

// Save to Supabase
async function saveToSupabase(formResponse) {
  // Check if submission already exists (idempotency)
  const { data: existing } = await supabase
    .from('submissions')
    .select('id')
    .eq('submission_id', formResponse.token)
    .single();

  if (existing) {
    console.log(`Submission ${formResponse.token} already exists, skipping`);
    return existing.id;
  }

  // Insert submission (raw_data contains complete backup)
  const { data: submission, error: submissionError } = await supabase
    .from('submissions')
    .insert({
      form_id: formResponse.form_id,
      submission_id: formResponse.token,
      submitted_at: formResponse.submitted_at,
      raw_data: formResponse, // Complete JSON backup stored here
    })
    .select()
    .single();

  if (submissionError) throw submissionError;

  // Insert answers (if any exist)
  if (formResponse.answers && formResponse.answers.length > 0) {
    const answers = formResponse.answers
      .filter(answer => answer && answer.field) // Skip invalid answers
      .map(answer => ({
        submission_id: submission.id,
        question_id: answer.field.id,
        question_text: answer.field.ref || answer.field.title || 'Unknown',
        answer_text: getAnswerText(answer),
        answer_type: answer.type,
      }));

    if (answers.length > 0) {
      const { error: answersError } = await supabase
        .from('answers')
        .insert(answers);

      if (answersError) {
        console.error('Error saving answers:', answersError);
        // Don't fail the whole submission for answer errors
      }
    }
  }

  console.log(`Saved to Supabase: ${submission.id}`);
  return submission.id;
}

// Update Airtable
async function updateAirtable(formResponse, dbSubmissionId) {
  // Check if record already exists in Airtable
  const searchUrl = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}?filterByFormula={Submission ID}="${formResponse.token}"`;
  
  const searchResponse = await fetch(searchUrl, {
    headers: {
      'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
    },
  });

  const searchData = await searchResponse.json();
  
  if (searchData.records && searchData.records.length > 0) {
    console.log('Record already exists in Airtable, skipping');
    return;
  }

  // Extract common fields with flexible matching
  const answers = formResponse.answers || [];
  
  // Try multiple strategies to find name
  const name = answers.find(a => 
    a.field?.title?.toLowerCase().includes('name') ||
    a.field?.ref?.toLowerCase().includes('name') ||
    a.type === 'text'
  )?.text || answers.find(a => a.text)?.text || 'N/A';

  // Find email
  const email = answers.find(a => 
    a.type === 'email'
  )?.email || answers.find(a => 
    a.field?.title?.toLowerCase().includes('email')
  )?.text || 'N/A';

  // Build record with only fields that exist in Airtable
  const fields = {
    'Submission ID': formResponse.token,
    'Submitted At': formResponse.submitted_at,
  };

  // Add optional fields only if they're reasonable values
  if (name && name !== 'N/A' && name.length < 200) {
    fields['Name'] = name;
  }
  
  if (email && email !== 'N/A' && email.includes('@')) {
    fields['Email'] = email;
  }

  if (formResponse.definition?.title) {
    fields['Form Name'] = formResponse.definition.title;
  }

  fields['Status'] = 'New';
  
  if (process.env.SUPABASE_URL) {
    fields['View Data'] = `${process.env.SUPABASE_URL}/project/default/editor`;
  }

  const record = { fields };

  const response = await fetch(
    `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(record),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Airtable error: ${response.statusText} - ${errorText}`);
  }

  console.log('Updated Airtable');
}

// Verify Typeform webhook signature
function verifyTypeformSignature(payload, signature) {
  const crypto = require('crypto');
  const hash = crypto
    .createHmac('sha256', process.env.TYPEFORM_WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest('base64');
  
  return `sha256=${hash}` === signature;
}

// Helper to extract answer text
function getAnswerText(answer) {
  if (!answer) return null;
  
  switch (answer.type) {
    case 'text':
    case 'email':
    case 'url':
      return answer[answer.type];
    case 'choice':
      return answer.choice?.label;
    case 'choices':
      return answer.choices?.labels?.join(', ');
    case 'number':
      return answer.number?.toString();
    case 'boolean':
      return answer.boolean ? 'Yes' : 'No';
    case 'date':
      return answer.date;
    case 'file_url':
      return answer.file_url;
    default:
      return JSON.stringify(answer);
  }
}
