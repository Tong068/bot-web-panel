import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { library } from '@fortawesome/fontawesome-svg-core'
import { faEnvelope, faUser, faGear, faArrowRightFromBracket, faMoon, faSun, faImage, faFolder, faFaceLaugh, faPaperPlane, faReply, faCopy, faTrashCan, faXmark, faAngleLeft, faChevronDown, faMagnifyingGlass, faAt, faSpinner, faDownload, faRotateRight, faCircle, faThumbtack, faBell, faUserGroup, faExpand, faPlus, faMinus, faArrowLeft, faArrowRight, faCheck, faFlag } from '@fortawesome/free-solid-svg-icons'
import App from './App.vue'
import './upstream/css/view.css'
import './upstream/css/chat.css'
import './upstream/css/msg.css'
import './upstream/css/options.css'
import './panel.css'
library.add(faEnvelope, faUser, faGear, faArrowRightFromBracket, faMoon, faSun, faImage, faFolder, faFaceLaugh, faPaperPlane, faReply, faCopy, faTrashCan, faXmark, faAngleLeft, faChevronDown, faMagnifyingGlass, faAt, faSpinner, faDownload, faRotateRight, faCircle, faThumbtack, faBell, faUserGroup, faExpand, faPlus, faMinus, faArrowLeft, faArrowRight, faCheck, faFlag)
createApp(App).use(createPinia()).component('FontAwesomeIcon', FontAwesomeIcon).mount('#app')
