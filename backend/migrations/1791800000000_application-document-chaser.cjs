'use strict';

// Chasing the documents an application is still missing.
//
// A rider submits, and the three things actually needed — ID, driver's
// licence, three payslips — are uploaded afterwards, against the application
// that submitting created. Most people do it in the same minute. The rest were
// chased by somebody reading the queue and typing an email by hand: on the day
// this was written, 108 of the 116 applications sitting in 'submitted' were
// incomplete, and 508 of the last 3082 had never uploaded anything at all.
//
// `documents_chased_at` is what stops that email being sent twice. The obvious
// alternative — the existing "has a notification like this gone out today"
// check — only guards the same calendar day, so a sweep that runs every
// quarter of an hour would behave for a day and then start again at midnight.
// A column on the application says, permanently and queryably, that this
// particular person has already been asked.
//
// Nullable and left NULL for every existing row on purpose: nobody is
// retro-marked as chased, so the backlog is a decision to be made by whoever
// turns the sweep on, not something this migration quietly forecloses.

exports.up = (pgm) => {
  pgm.addColumns('applications', {
    documents_chased_at: {
      type: 'timestamptz',
      comment: 'When the rider was emailed about documents still outstanding. NULL = never asked.',
    },
  });

  // The sweep's own query: the open queue, oldest first. Partial, because
  // 'submitted' is a small and shrinking slice of a table that mostly holds
  // applications already decided.
  pgm.createIndex('applications', ['submitted_at'], {
    name: 'idx_applications_awaiting_documents',
    where: "status = 'submitted' AND documents_chased_at IS NULL",
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('applications', ['submitted_at'], { name: 'idx_applications_awaiting_documents' });
  pgm.dropColumns('applications', ['documents_chased_at']);
};
