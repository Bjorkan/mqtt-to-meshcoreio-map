//! One active upload and a bounded number of waiting jobs. The active job is
//! not included in the configured waiting queue capacity.
use crate::reader::Job;
use std::collections::{HashSet, VecDeque};

pub struct UploadQueue {
    waiting: VecDeque<Job>,
    active_nodes: HashSet<String>,
    in_flight: Option<(String, i64)>,
    capacity: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    Accepted,
    Duplicate,
    Full,
    Disabled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryOutcome {
    Queued,
    Exhausted,
    Full,
    NotActive,
}

impl UploadQueue {
    pub fn new(capacity: usize) -> Self {
        Self {
            waiting: VecDeque::new(),
            active_nodes: HashSet::new(),
            in_flight: None,
            capacity,
        }
    }

    pub fn admit(&mut self, job: Job) -> Admission {
        if job.retries_left <= 0 {
            return Admission::Disabled;
        }
        if self.active_nodes.contains(&job.node_key) {
            return Admission::Duplicate;
        }
        if self.waiting.len() >= self.capacity {
            return Admission::Full;
        }
        self.active_nodes.insert(job.node_key.clone());
        self.waiting.push_back(job);
        Admission::Accepted
    }

    pub fn begin(&mut self) -> Option<Job> {
        if self.in_flight.is_some() {
            return None;
        }
        let mut job = self.waiting.pop_front()?;
        job.attempts += 1;
        self.in_flight = Some((job.advert_key.clone(), job.attempts));
        Some(job)
    }
    pub fn has_waiting(&self) -> bool {
        !self.waiting.is_empty()
    }
    pub fn waiting_len(&self) -> usize {
        self.waiting.len()
    }

    pub fn finish(&mut self, job: &Job) -> bool {
        if self.in_flight.as_ref() != Some(&(job.advert_key.clone(), job.attempts)) {
            return false;
        }
        self.in_flight = None;
        self.active_nodes.remove(&job.node_key);
        true
    }

    pub fn retry(&mut self, mut job: Job) -> RetryOutcome {
        if self.in_flight.as_ref() != Some(&(job.advert_key.clone(), job.attempts)) {
            return RetryOutcome::NotActive;
        }
        self.in_flight = None;
        job.retries_left -= 1;
        if job.retries_left <= 0 {
            self.active_nodes.remove(&job.node_key);
            return RetryOutcome::Exhausted;
        }
        if self.waiting.len() >= self.capacity {
            self.active_nodes.remove(&job.node_key);
            return RetryOutcome::Full;
        }
        self.waiting.push_back(job);
        RetryOutcome::Queued
    }
}
