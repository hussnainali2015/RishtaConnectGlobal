'use strict';
/* TEMPORARY sample profiles for the "Featured profiles" section while the site is new.
 * They are always labelled "Sample profile" on the page, are never shown as verified, and cannot be contacted.
 *
 * HOW TO REMOVE THEM LATER (any one of these):
 *   1. Easiest: in Render > Environment set  SHOW_SAMPLE_PROFILES=false  and redeploy.
 *   2. Or delete this file (featured-samples.js) from GitHub. The site works without it.
 *   3. Or do nothing: they disappear on their own, one by one, as real members tick "Show me in Featured profiles"
 *      (once 6 real profiles are featured, no samples are left).
 */
module.exports = [
  { n: 'Ayesha',  g: 'Female', a: 27, c: 'Riyadh, Saudi Arabia',   j: 'Teacher' },
  { n: 'Omar',    g: 'Male',   a: 30, c: 'London, United Kingdom', j: 'Software engineer' },
  { n: 'Fatima',  g: 'Female', a: 25, c: 'Karachi, Pakistan',      j: 'Doctor' },
  { n: 'Hamza',   g: 'Male',   a: 29, c: 'Dubai, UAE',             j: 'Accountant' },
  { n: 'Maryam',  g: 'Female', a: 28, c: 'Toronto, Canada',        j: 'Pharmacist' },
  { n: 'Bilal',   g: 'Male',   a: 31, c: 'Manchester, United Kingdom', j: 'Civil engineer' },
];
