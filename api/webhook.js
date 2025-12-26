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
        question_text: answer.field.title || answer.field.ref || 'Unknown',
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

  const answers = formResponse.answers || [];
  
  // Build base fields
  const fields = {
    'Submission ID': formResponse.token,
    'Submitted At': formResponse.submitted_at,
    'Form Name': formResponse.definition?.title || 'Unknown',
    'Status': 'New',
  };
  
  if (process.env.SUPABASE_URL) {
    fields['View Data'] = `${process.env.SUPABASE_URL}/project/default/editor`;
  }

  // Map ALL answers to Airtable columns
  // This maps each question to a specific column based on question text
  answers.forEach((answer) => {
    const questionTitle = (answer.field?.title || '').toLowerCase();
    const answerValue = getAnswerText(answer);
    
    if (!answerValue || answerValue === 'N/A') return;

    // Map questions to Airtable columns (truncate to 100k chars for Airtable limit)
    const truncatedValue = answerValue.length > 100000 ? answerValue.substring(0, 100000) : answerValue;

    // Map based on question text
    if (questionTitle.includes('exploring this purchase')) {
      fields['Purchase Duration'] = truncatedValue;
    } else if (questionTitle.includes('full name')) {
      fields['Full Name'] = truncatedValue;
      fields['Name'] = truncatedValue; // Also set legacy Name field
    } else if (questionTitle.includes('email')) {
      fields['Email Address'] = truncatedValue;
      fields['Email'] = truncatedValue; // Also set legacy Email field
    } else if (questionTitle.includes('mobile number') || questionTitle.includes('whatsapp')) {
      fields['Mobile Number'] = truncatedValue;
    } else if (questionTitle.includes('where did you hear') || questionTitle.includes('hear about us')) {
      fields['Referral Source'] = truncatedValue;
    } else if (questionTitle.includes('age group')) {
      fields['Age Group'] = truncatedValue;
    } else if (questionTitle.includes('where do you currently live')) {
      fields['Current Location'] = truncatedValue;
    } else if (questionTitle.includes('current profession')) {
      fields['Current Profession'] = truncatedValue;
    } else if (questionTitle.includes('household income')) {
      fields['Household Income'] = truncatedValue;
    } else if (questionTitle.includes('household size')) {
      fields['Household Size'] = truncatedValue;
    } else if (questionTitle.includes('buying journey')) {
      fields['Buying Journey Stage'] = truncatedValue;
    } else if (questionTitle.includes('properties have you purchased')) {
      fields['Properties Purchased Before'] = truncatedValue;
    } else if (questionTitle.includes('prompting this property search')) {
      fields['Purchase Prompt'] = truncatedValue;
    } else if (questionTitle.includes('dream property') || questionTitle.includes('ideal investment')) {
      fields['Dream Property Description'] = truncatedValue;
    } else if (questionTitle.includes('tell us anything else')) {
      fields['Additional Notes'] = truncatedValue;
    } else if (questionTitle.includes('preferred location')) {
      fields['Preferred Locations'] = truncatedValue;
    } else if (questionTitle.includes('main intention behind this investment')) {
      fields['Investment Intention'] = truncatedValue;
    } else if (questionTitle.includes('vibe are you looking for')) {
      fields['Preferred Vibe'] = truncatedValue;
    } else if (questionTitle.includes('asset type')) {
      fields['Asset Type'] = truncatedValue;
    } else if (questionTitle.includes('budget range')) {
      fields['Budget Range'] = truncatedValue;
    } else if (questionTitle.includes('ownership structure')) {
      fields['Ownership Structure'] = truncatedValue;
    } else if (questionTitle.includes('possession timeline')) {
      fields['Possession Timeline'] = truncatedValue;
    } else if (questionTitle.includes('close the deal')) {
      fields['Deal Closure Timeline'] = truncatedValue;
    } else if (questionTitle.includes('management model')) {
      fields['Management Model'] = truncatedValue;
    } else if (questionTitle.includes('funding preference')) {
      fields['Funding Preference'] = truncatedValue;
    } else if (questionTitle.includes('inspires this investment')) {
      fields['Investment Inspiration'] = truncatedValue;
    } else if (questionTitle.includes('tell us more') && questionTitle.includes('investment')) {
      fields['Investment Details'] = truncatedValue;
    } else if (questionTitle.includes('matters most') && questionTitle.includes('location')) {
      fields['Location Priorities'] = truncatedValue;
    } else if (questionTitle.includes('climate do you')) {
      fields['Preferred Climate'] = truncatedValue;
    } else if (questionTitle.includes('type of area')) {
      fields['Area Type Preference'] = truncatedValue;
    } else if (questionTitle.includes('too far')) {
      fields['Distance Tolerance'] = truncatedValue;
    } else if (questionTitle.includes('tell us more') && questionTitle.includes('location')) {
      fields['Location Details'] = truncatedValue;
    } else if (questionTitle.includes('community setup')) {
      fields['Community Setup'] = truncatedValue;
    } else if (questionTitle.includes('community be friendly')) {
      fields['Community Friendly For'] = truncatedValue;
    } else if (questionTitle.includes('natural features')) {
      fields['Natural Features'] = truncatedValue;
    } else if (questionTitle.includes('terrain')) {
      fields['Terrain Preference'] = truncatedValue;
    } else if (questionTitle.includes('preferred views')) {
      fields['Preferred Views'] = truncatedValue;
    } else if (questionTitle.includes('outdoor amenities')) {
      fields['Outdoor Amenities'] = truncatedValue;
    } else if (questionTitle.includes('tell us more') && questionTitle.includes('amenities')) {
      fields['Amenities Details'] = truncatedValue;
    } else if (questionTitle.includes('unit configuration')) {
      fields['Unit Configuration'] = truncatedValue;
    } else if (questionTitle.includes('facing direction') || questionTitle.includes('vastu')) {
      fields['House Facing Direction'] = truncatedValue;
    } else if (questionTitle.includes('furnishing level')) {
      fields['Furnishing Level'] = truncatedValue;
    } else if (questionTitle.includes('interior style')) {
      fields['Interior Style'] = truncatedValue;
    } else if (questionTitle.includes('smart home')) {
      fields['Smart Home Preferences'] = truncatedValue;
    } else if (questionTitle.includes('must-have features')) {
      fields['Must Have Features'] = truncatedValue;
    } else if (questionTitle.includes('tell us more') && questionTitle.includes('home')) {
      fields['Home Details'] = truncatedValue;
    }
  });

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
