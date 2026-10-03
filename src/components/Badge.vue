<script setup>import {labels} from '../../shared/contracts.js';defineProps({status:String});</script>
<template><span class="badge" :class="status"><i></i>{{ labels[status]||status }}</span></template>
